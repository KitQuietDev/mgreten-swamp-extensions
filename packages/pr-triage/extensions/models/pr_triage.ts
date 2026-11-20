/** Scan open PRs and serve the resulting dashboard. @module */
import { z } from "npm:zod@4";
import {
  BoardSchema,
  type MyPrRow,
  type PeerRow,
  type PrBoard,
} from "./board_schema.ts";
import { createHandler, readBoard, webhookBridge } from "./server.ts";

const colorMap = z.record(
  z.string().regex(/^[a-z][a-z-]*$/),
  z.string().regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i),
);
/** Shared report and behavior settings. */
export const Settings = z.object({
  repo: z.string().regex(/^[a-z\d][\w.-]*\/[a-z\d_.][\w.-]*$/i),
  login: z.string().min(1),
  peers: z.array(z.string()).default([]),
  reviewPool: z.boolean().default(false),
  limit: z.number().int().min(1).max(1000).default(100),
  outputDir: z.string().default("~/.pr-triage"),
  toursDir: z.string().default("~/.pr-tour/pages"),
  issueLinksPath: z.string().optional(),
  port: z.number().int().min(1024).max(65535).default(8765),
  webhookPort: z.number().int().min(1024).max(65535).default(8899),
  webhookSecretFile: z.string().optional(),
  webhookSignature: z.object({
    header: z.string().regex(/^X-[a-z0-9-]+$/i),
    prefix: z.enum(["", "sha256="]),
  }).optional(),
  actionRoutes: z.record(
    z.string().regex(/^pr-[a-z-]+$/),
    z.string().regex(/^[a-z][a-z-]+$/),
  ).default({ "pr-tour": "pr-tour" }),
  theme: z.object({ dark: colorMap.optional(), light: colorMap.optional() })
    .default({}),
});

/** Expand the home directory in user-supplied paths. */
export function expandPath(path: string): string {
  if (!path.startsWith("~/")) return path;
  const home = Deno.env.get("HOME");
  if (!home) throw new Error("HOME is unset; configure an absolute path");
  return `${home}/${path.slice(2)}`;
}

const Prs = z.array(z.object({
  number: z.number().positive().int(),
  title: z.string(),
  url: z.string(),
  author: z.object({ login: z.string() }).nullable(),
  headRefName: z.string(),
  headRefOid: z.string(),
  baseRefName: z.string(),
  isCrossRepository: z.boolean(),
  isDraft: z.boolean(),
  updatedAt: z.string(),
  additions: z.number().nonnegative().int(),
  deletions: z.number().nonnegative().int(),
  reviewDecision: z.string(),
  statusCheckRollup: z.array(z.object({
    name: z.string().optional(),
    context: z.string().optional(),
    conclusion: z.string().optional(),
    status: z.string().optional(),
    state: z.string().optional(),
  })).nullable(),
}));
const IssueLinks = z.record(
  z.string().regex(/^[1-9]\d*$/),
  z.array(z.object({
    identifier: z.string(),
    title: z.string(),
    url: z.url({ protocol: /^https?$/ }),
  })),
);

/** Project GitHub's open PR list into the dashboard lanes without running any agents. */
export function deriveBoard(
  raw: unknown,
  settings: z.infer<typeof Settings>,
  scannedAt: string,
  links: unknown = {},
): PrBoard {
  const prs = Prs.parse(raw);
  const issues = IssueLinks.parse(links);
  const myPrs: MyPrRow[] = [];
  const peerPrs: PeerRow[] = [];
  const reviewPoolPrs: PeerRow[] = [];
  const peers = new Set(settings.peers.map((login) => login.toLowerCase()));
  const login = settings.login.toLowerCase();
  for (const pr of prs) {
    const author = pr.author?.login ?? "unknown";
    const checks = pr.statusCheckRollup ?? [];
    const failures = checks.filter(({ conclusion, state }) =>
      ["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "ERROR"].includes(
        conclusion ?? state ?? "",
      )
    );
    const pending = checks.some(({ status, state }) =>
      (status !== undefined && status !== "COMPLETED") || state === "PENDING" ||
      state === "EXPECTED"
    );
    const ciState = failures.length
      ? "failure"
      : pending
      ? "pending"
      : checks.length
      ? "success"
      : "unknown";
    const health = failures.length
      ? "red"
      : pending || pr.reviewDecision === "CHANGES_REQUESTED"
      ? "yellow"
      : checks.length
      ? "green"
      : "unknown";
    const row = {
      prNumber: pr.number,
      title: pr.title,
      url: pr.url,
      headSha: pr.headRefOid,
      additions: pr.additions,
      deletions: pr.deletions,
      health,
      issueLinks: issues[String(pr.number)],
    } as const;
    if (author.toLowerCase() === login) {
      myPrs.push({
        ...row,
        headRef: pr.headRefName,
        isDraft: pr.isDraft,
        ciState,
        failingChecks: failures.map((check) => ({
          name: check.name ?? check.context ?? "Check",
          source: "github",
          failureClass: "check",
          detailsUrl: "",
        })),
        reviewState: pr.reviewDecision.toLowerCase(),
        lastActivityAt: pr.updatedAt,
        unaddressedCount: 0,
        needsVerificationCount: 0,
        hasDraftReply: false,
        draftReplyCount: 0,
        stackId: String(pr.number),
        stackPos: 0,
        stackSize: 1,
        reviewThreads: [],
        incomingFeedback: [],
      });
    } else if (!pr.isDraft) {
      const peer = { ...row, author, reason: "new", hasDraft: false } as const;
      if (peers.has(author.toLowerCase())) peerPrs.push(peer);
      else if (settings.reviewPool) reviewPoolPrs.push(peer);
    }
  }

  // Match base branches only to unique non-fork heads. Discard ambiguous
  // branches rather than presenting a misleading stack.
  const byHead = new Map<string, MyPrRow | undefined>();
  for (const row of myPrs) {
    const pr = prs.find(({ number }) => number === row.prNumber);
    if (!pr || pr.isCrossRepository) continue;
    byHead.set(row.headRef, byHead.has(row.headRef) ? undefined : row);
  }
  const bases = new Map(prs.map((pr) => [pr.number, pr.baseRefName]));
  const groups = new Map<number, { row: MyPrRow; depth: number }[]>();
  for (const row of myPrs) {
    const seen = new Set([row.prNumber]);
    let root = row;
    for (;;) {
      const parent = byHead.get(bases.get(root.prNumber) ?? "");
      if (!parent) break;
      if (seen.has(parent.prNumber)) {
        root = row;
        seen.clear();
        break;
      }
      seen.add(parent.prNumber);
      root = parent;
    }
    const group = groups.get(root.prNumber) ?? [];
    group.push({ row, depth: Math.max(0, seen.size - 1) });
    groups.set(root.prNumber, group);
  }
  for (const [root, group] of groups) {
    group.sort((a, b) => a.depth - b.depth || a.row.prNumber - b.row.prNumber);
    group.forEach(({ row }, stackPos) =>
      Object.assign(row, {
        stackId: String(root),
        stackPos,
        stackSize: group.length,
      })
    );
  }

  const rows = [...myPrs, ...peerPrs, ...reviewPoolPrs];
  const count = (health: MyPrRow["health"]) =>
    rows.filter((row) => row.health === health).length;
  return BoardSchema.parse({
    schemaVersion: 1,
    scannedAt,
    repo: settings.repo,
    summary: {
      total: rows.length,
      red: count("red"),
      yellow: count("yellow"),
      green: count("green"),
      unknown: count("unknown"),
      needsAction: myPrs.filter((row) =>
        row.ciState === "failure" || row.reviewState === "changes_requested"
      ).length,
    },
    myPrs,
    peerPrs,
    reviewPoolPrs,
  });
}

type Context = {
  globalArgs: z.infer<typeof Settings>;
  writeResource: (
    spec: string,
    name: string,
    value: PrBoard,
  ) => Promise<unknown>;
  logger: { info: (message: string, fields: Record<string, unknown>) => void };
};

/** Refresh the board or serve it from a separate instance. */
export const model = {
  type: "@mgreten/pr-triage",
  version: "2026.11.20.1",
  globalArguments: Settings,
  reports: ["@mgreten/pr-triage-dashboard"],
  resources: {
    board: {
      description: "Versioned open-PR board snapshot",
      schema: BoardSchema,
      lifetime: "7d" as const,
      garbageCollection: 12,
    },
  },
  methods: {
    scan: {
      description:
        "Read open GitHub PRs and update the board. Never runs reviews or tours.",
      arguments: z.object({}),
      execute: async (_args: object, context: Context) => {
        const g = Settings.parse(context.globalArgs);
        const fields =
          "number,title,url,author,headRefName,headRefOid,baseRefName,isCrossRepository,isDraft,updatedAt,additions,deletions,reviewDecision,statusCheckRollup";
        const result = await new Deno.Command("gh", {
          args: [
            "pr",
            "list",
            "--repo",
            g.repo,
            "--state",
            "open",
            "--limit",
            String(g.limit),
            "--json",
            fields,
          ],
          signal: AbortSignal.timeout(60_000),
        }).output();
        const decoder = new TextDecoder();
        if (!result.success) {
          throw new Error(
            `gh pr list failed: ${decoder.decode(result.stderr).trim()}`,
          );
        }
        const links: unknown = g.issueLinksPath
          ? JSON.parse(await Deno.readTextFile(expandPath(g.issueLinksPath)))
          : {};
        const board = deriveBoard(
          JSON.parse(decoder.decode(result.stdout)),
          g,
          new Date().toISOString(),
          links,
        );
        return {
          dataHandles: [
            await context.writeResource("board", "board-latest", board),
          ],
        };
      },
    },
    serve: {
      description:
        "Serve the dashboard and tour pages on loopback; optionally forward allowlisted actions to swamp serve.",
      arguments: z.object({}),
      execute: async (_args: object, context: Context) => {
        const g = Settings.parse(context.globalArgs);
        const origin = `http://127.0.0.1:${g.port}`;
        const tours = expandPath(g.toursDir);
        const out = expandPath(g.outputDir);
        const secret = g.webhookSecretFile
          ? (await Deno.readTextFile(expandPath(g.webhookSecretFile))).trim()
          : "";
        const handler = createHandler({
          origin,
          theme: g.theme,
          board: () => readBoard(out, tours),
          tour: async (name) => {
            try {
              return await Deno.readFile(`${tours}/${name}`);
            } catch (error) {
              if (error instanceof Deno.errors.NotFound) return null;
              throw error;
            }
          },
          action: secret
            ? webhookBridge(
              `http://127.0.0.1:${g.webhookPort}`,
              secret,
              g.actionRoutes,
              g.webhookSignature,
            )
            : () =>
              Promise.resolve(
                new Response("No webhooks configured", { status: 404 }),
              ),
        });
        await Deno.serve({
          hostname: "127.0.0.1",
          port: g.port,
          onListen: () => context.logger.info("Open {origin}", { origin }),
        }, handler).finished;
        return { dataHandles: [] };
      },
    },
  },
};
