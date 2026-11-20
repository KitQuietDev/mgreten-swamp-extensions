import { assertEquals, assertMatch, assertThrows } from "@std/assert";
import { deriveBoard, Settings } from "./pr_triage.ts";
import { createHandler, webhookBridge } from "./server.ts";
import { report } from "../reports/pr_triage_dashboard.ts";

const origin = "http://127.0.0.1:8765";
const at = "2026-01-01T00:00:00Z";
const config = Settings.parse({
  repo: "acme/widgets",
  login: "example",
  peers: ["Peer"],
  reviewPool: true,
});

function row(
  number: number,
  login: string,
  headRefName: string,
  baseRefName = "main",
) {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/widgets/pull/${number}`,
    author: { login },
    headRefName,
    baseRefName,
    headRefOid: `${number}`.padStart(40, "a"),
    updatedAt: at,
    isDraft: false,
    isCrossRepository: false,
    additions: 13,
    deletions: 6,
    reviewDecision: "",
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
  };
}

Deno.test("scan distinguishes a failed stacked child from its healthy base and excludes draft peers", () => {
  const board = deriveBoard(
    [
      {
        ...row(3, "Example", "child", "base"),
        statusCheckRollup: [{
          status: "COMPLETED",
          conclusion: "FAILURE",
          name: "tests",
        }],
      },
      row(19, "example", "base"),
      row(21, "peer", "feature"),
      { ...row(22, "peer", "unfinished"), isDraft: true },
      row(23, "another", "feature"),
    ],
    config,
    at,
    {
      19: [{ identifier: "W-1", title: "Queue", url: "https://example.com/1" }],
    },
  );
  assertEquals(
    board.myPrs.map((
      { prNumber, stackPos, stackId, health },
    ) => [prNumber, stackPos, stackId, health]),
    [
      [3, 1, "19", "red"],
      [19, 0, "19", "green"],
    ],
  );
  assertEquals(board.myPrs[1].issueLinks?.[0].identifier, "W-1");
  assertEquals(board.peerPrs.map((pr) => pr.prNumber), [21]);
  assertEquals(board.reviewPoolPrs?.map((pr) => pr.prNumber), [23]);
  assertEquals(board.summary, {
    total: 4,
    red: 1,
    yellow: 0,
    green: 3,
    unknown: 0,
    needsAction: 1,
  });
  assertThrows(() =>
    deriveBoard([], config, at, {
      19: [{ identifier: "W-1", title: "Bad URL", url: "javascript:void(0)" }],
    })
  );
});

Deno.test("dashboard routes do not forward until the browser explicitly POSTs from the dashboard origin", async () => {
  const board = deriveBoard([row(19, "example", "branch")], config, at);
  const forwarded: [string, string][] = [];
  const handler = createHandler({
    origin,
    board: () => Promise.resolve(board),
    tour: (file) =>
      Promise.resolve(
        file === "19.html" ? new TextEncoder().encode("<h1>Tour</h1>") : null,
      ),
    action: (name, body) => {
      forwarded.push([name, body]);
      return Promise.resolve(new Response("queued", { status: 202 }));
    },
  });
  assertMatch(
    await (await handler(new Request(origin))).text(),
    /PR &amp; CI Triage/,
  );
  const update = await (await handler(new Request(`${origin}/board`))).json();
  assertEquals(update.laneCounts.my, 1);
  assertEquals(
    (await handler(new Request(`${origin}/tours/19.html`))).status,
    200,
  );
  assertEquals(
    (await handler(new Request(`${origin}/tours/webhook-secret`))).status,
    404,
  );
  assertEquals(
    (await handler(new Request("http://example.com/board"))).status,
    403,
  );
  assertEquals(forwarded, []);

  const action = `${origin}/actions/pr-tour`;
  const body = '{"prNumber":19}';
  const post = (referrer: string) =>
    new Request(action, {
      method: "POST",
      body,
      headers: {
        origin: referrer,
        "content-type": "application/json",
        "x-pr-triage": "1",
      },
    });
  assertEquals((await handler(post("https://example.com"))).status, 403);
  assertEquals(forwarded, []);
  assertEquals((await handler(post(origin))).status, 202);
  assertEquals(forwarded, [["pr-tour", body]]);
});

Deno.test("the scan report publishes the versioned snapshot and only valid theme overrides", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const board = deriveBoard(
      [{ ...row(19, "example", "branch"), title: "<script>alert(1)</script>" }],
      config,
      at,
    );
    await report.execute({
      globalArgs: {
        ...config,
        outputDir: dir,
        theme: { dark: { accent: "#4b9" } },
      },
      modelType: "@mgreten/pr-triage",
      modelId: "example-scan",
      dataHandles: [{ specName: "board", name: "board-latest", version: 1 }],
      dataRepository: {
        getContent: () =>
          Promise.resolve(new TextEncoder().encode(JSON.stringify(board))),
      },
    });
    assertEquals(
      JSON.parse(await Deno.readTextFile(`${dir}/board.json`)),
      JSON.parse(JSON.stringify(board)),
    );
    const html = await Deno.readTextFile(`${dir}/dashboard.html`);
    assertMatch(html, /--accent:#4b9/);
    assertMatch(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assertEquals(
      Array.from(Deno.readDirSync(dir), (entry) => entry.name).sort(),
      ["board.json", "dashboard.html"],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("webhook bridge forwards exactly the signed request bytes and never guesses a route", async () => {
  const controller = new AbortController();
  const requests: Array<Array<string | null>> = [];
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    signal: controller.signal,
    onListen: () => {},
  }, async (request) => {
    requests.push([
      new URL(request.url).pathname,
      request.headers.get("X-PrTriage-Signature"),
      request.headers.get("X-Webhook-Signature"),
      await request.text(),
    ]);
    return new Response("queued", { status: 202 });
  });
  try {
    const bridge = webhookBridge(
      `http://127.0.0.1:${server.addr.port}`,
      "fixture-signing-key",
      { "pr-tour": "tour-queue" },
    );
    assertEquals((await bridge("pr-other", "{}")).status, 404);
    assertEquals(requests, []);
    const response = await bridge("pr-tour", '{"prNumber":19}');
    assertEquals(response.status, 202);
    assertEquals(await response.text(), "queued");
    assertEquals(requests, [[
      "/tour-queue",
      "sha256=5a87823396f64ef64b83bdee31d2d9db787f9f35c01730500d17fa8a14f50086",
      null,
      '{"prNumber":19}',
    ]]);
    const legacy = webhookBridge(
      `http://127.0.0.1:${server.addr.port}`,
      "fixture-signing-key",
      { "pr-tour": "tour-queue" },
      { header: "X-Webhook-Signature", prefix: "" },
    );
    await (await legacy("pr-tour", '{"prNumber":19}')).text();
    assertEquals(requests[1], [
      "/tour-queue",
      null,
      "5a87823396f64ef64b83bdee31d2d9db787f9f35c01730500d17fa8a14f50086",
      '{"prNumber":19}',
    ]);
  } finally {
    controller.abort();
    await server.finished;
  }
});
