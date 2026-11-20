/** Loopback dashboard and signed webhook bridge. @module */
import { BoardSchema, type PrBoard } from "./board_schema.ts";
import { DraftState } from "./review_draft.ts";
import {
  type DashboardTheme,
  enrichBoardWithTours,
  renderDashboardHtml,
  renderLaneBodies,
  type TourState,
} from "../reports/dashboard.ts";

/** Return the lane fragments used to refresh the board without losing drafts. */
export function boardPayload(board: PrBoard | null) {
  const mine = board?.myPrs ?? [];
  const peers = board?.peerPrs ?? [];
  const pool = board?.reviewPoolPrs ?? [];
  const needs = (row: (typeof mine)[number]) =>
    row.needsYou && row.fixPreparation?.status !== "running";
  return {
    ok: true,
    scannedAt: board?.scannedAt ?? null,
    repo: board?.repo ?? "",
    summary: board?.summary,
    laneCounts: {
      my: mine.filter((row) => !needs(row)).length,
      needsyou: mine.filter(needs).length +
        [...peers, ...pool].filter((row) => row.needsYou).length,
      peer: peers.filter((row) => !row.needsYou).length,
      reviewpool: pool.filter((row) => !row.needsYou).length,
      agentfailures: board?.agentFailures?.length ?? 0,
    },
    ...renderLaneBodies(board),
  };
}

type Sources = {
  origin: string;
  board: () => Promise<PrBoard | null>;
  tour: (file: string) => Promise<Uint8Array<ArrayBuffer> | null>;
  action: (name: string, body: string) => Promise<Response>;
  theme?: DashboardTheme;
  verificationNotice?: string;
  reviewDraftDir?: string;
};

const headers = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

/** Route only dashboard pages, the live board, tour filenames, and same-origin action requests. */
export function createHandler(
  sources: Sources,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.origin !== sources.origin) {
      return new Response("Unexpected host", { status: 403 });
    }
    if (request.method === "GET") {
      if (url.pathname === "/board") {
        return Response.json(boardPayload(await sources.board()), { headers });
      }
      const htmlHeaders = {
        ...headers,
        "content-type": "text/html; charset=utf-8",
      };
      if (url.pathname === "/" || url.pathname === "/dashboard.html") {
        const html = renderDashboardHtml(
          await sources.board(),
          Date.now(),
          sources.theme,
          sources.verificationNotice,
        );
        return new Response(
          sources.reviewDraftDir
            ? html.replace(
              "</body>",
              `<script>${reviewControls}</script></body>`,
            )
            : html,
          { headers: htmlHeaders },
        );
      }
      const draft = /^\/review-draft\/([1-9]\d*)$/.exec(url.pathname);
      if (sources.reviewDraftDir && draft) {
        try {
          const path = `${sources.reviewDraftDir}/review-${draft[1]}.json`;
          return Response.json(
            DraftState.parse(JSON.parse(await Deno.readTextFile(path))),
            { headers },
          );
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
          return Response.json({ review: null, draftId: null }, { headers });
        }
      }
      const tour = /^\/tours\/([1-9]\d*(?:-[0-9a-f]{12})?\.html)$/.exec(
        url.pathname,
      );
      if (tour) {
        const page = await sources.tour(tour[1]);
        if (page) return new Response(page, { headers: htmlHeaders });
      }
    }
    const action = /^\/actions\/(pr-[a-z][a-z-]+)$/.exec(url.pathname);
    if (action && request.method === "POST") {
      if (
        request.headers.get("origin") !== sources.origin ||
        request.headers.get("x-pr-triage") !== "1" ||
        request.headers.get("content-type") !== "application/json"
      ) {
        return new Response("Expected a same-origin dashboard request", {
          status: 403,
        });
      }
      const body = await request.text();
      if (body.length > 128_000) {
        return new Response("Request too large", { status: 413 });
      }
      try {
        const result = await sources.action(action[1], body);
        return new Response(await result.text(), {
          status: result.status,
          headers: { ...headers, "content-type": "text/plain; charset=utf-8" },
        });
      } catch (error) {
        console.error("Dashboard action failed", error);
        return new Response("Webhook unavailable", { status: 502 });
      }
    }
    return new Response("Not found", { status: 404 });
  };
}

const reviewControls = String.raw`
  function mountReviews() {
    for (const card of document.querySelectorAll('#peer-lane-body .card[data-pr], #reviewpool-lane-body .card[data-pr]')) {
      if (card.querySelector('.public-review')) continue;
      const prNumber = Number(card.dataset.pr);
      const panel = document.createElement('div');
      panel.className = 'public-review';
      const text = document.createElement('pre');
      text.style.whiteSpace = 'pre-wrap';
      text.hidden = true;
      let displayed;
      async function show() {
        const response = await fetch('./review-draft/' + prNumber);
        if (!response.ok) throw Error('Draft unavailable: HTTP ' + response.status);
        displayed = await response.json();
        text.textContent = displayed.review?.body || 'No draft yet.';
        text.hidden = false;
      }
      for (const [label, kind] of [['Draft review','draft'], ['Show draft','show'], ['Stage review','send'], ['Dismiss draft','dismiss']]) {
        const button = document.createElement('button');
        button.className = 'pbtn';
        button.textContent = label;
        button.onclick = async () => {
          try {
            if (kind === 'show') return await show();
            if (kind === 'send' && (!displayed?.draftId || !confirm('Stage this displayed draft on GitHub?'))) return;
            button.disabled = true;
            const response = await fetch('./actions/pr-public-review', {
              method:'POST', headers:{'Content-Type':'application/json','X-Pr-Triage':'1'},
              body:JSON.stringify({prNumber, kind, ...(kind === 'send' ? {draftId:displayed.draftId} : {})})
            });
            if (!response.ok) throw Error('Request failed: HTTP ' + response.status);
            const message = kind === 'draft' ? 'Draft queued. Use Show draft to check for the result.' : 'Action queued. Check workflow history for the result.';
            displayed = undefined;
            text.hidden = false;
            text.textContent = message;
          } catch (error) { text.hidden = false; text.textContent = String(error); }
          finally { button.disabled = false; }
        };
        panel.append(button);
      }
      panel.append(text);
      card.append(panel);
    }
  }
  mountReviews();
  const observer = new MutationObserver(mountReviews);
  for (const id of ['peer-lane-body','reviewpool-lane-body']) {
    const lane = document.getElementById(id);
    if (lane) observer.observe(lane, {childList:true});
  }
`;

/** Load the published snapshot and discover tour pages without calling GitHub. */
export async function readBoard(
  outputDir: string,
  toursDir: string,
): Promise<PrBoard | null> {
  let board: PrBoard;
  try {
    board = BoardSchema.parse(
      JSON.parse(await Deno.readTextFile(`${outputDir}/board.json`)),
    );
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
  const states = new Map<number, TourState>();
  try {
    for await (const entry of Deno.readDir(toursDir)) {
      const match = /^(\d+)-([0-9a-f]{12})\.html$/.exec(entry.name);
      if (!match || !entry.isFile) continue;
      const prNumber = Number(match[1]);
      const state = states.get(prNumber) ?? { prNumber, pageShas: [] };
      state.pageShas.push(match[2]);
      states.set(prNumber, state);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return enrichBoardWithTours(board, [...states.values()], Date.now());
}

/** Send only configured loopback webhooks. Do not follow redirects or expose the signing key. */
export function webhookBridge(
  upstream: string,
  secret: string,
  routes: Record<string, string>,
  signature = { header: "X-PrTriage-Signature", prefix: "sha256=" },
) {
  const encoder = new TextEncoder();
  return async (name: string, body: string): Promise<Response> => {
    if (!Object.hasOwn(routes, name)) {
      return new Response("This action is not configured", { status: 404 });
    }
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
    const sig = Array.from(
      new Uint8Array(digest),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    return await fetch(`${upstream}/${routes[name]}`, {
      method: "POST",
      body,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "content-type": "application/json",
        [signature.header]: `${signature.prefix}${sig}`,
      },
    });
  };
}
