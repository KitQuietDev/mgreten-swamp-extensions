// Demo PR triage dashboard on fictional data, for recording a walkthrough.
// It renders the real dashboard and tour pages, but the board, the PRs, and
// the tours are invented (see tours.ts) and every button is faked locally:
// nothing reads swamp data, calls GitHub, or runs an agent.
//
//   deno run --allow-net=127.0.0.1:8897 --allow-env=HOME,DEMO_PORT,DEMO_BUILD_MS packages/pr-triage/demo/serve.ts
//   open http://127.0.0.1:8897/
//
// Clicking 🧭 Tour on #482 "builds" its tour for BUILD_MS, then the next
// board poll (every 30s, or a reload) links to it.

import {
  enrichBoardWithTours,
  type TourState,
} from "../extensions/reports/dashboard.ts";
import {
  type MyPrRow,
  type PeerRow,
  type PrBoard,
} from "../extensions/models/board_schema.ts";
import { createHandler } from "../extensions/models/server.ts";
import { renderTourPage } from "../../pr-tour/extensions/reports/pr_tour_report.ts";
import { REPO, TOURS } from "./tours.ts";

const PORT = Number(Deno.env.get("DEMO_PORT") ?? "8897");
const BUILD_MS = Number(Deno.env.get("DEMO_BUILD_MS") ?? "12000");
const ME = "you";
const ago = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();
const pr = (n: number) => `https://github.com/${REPO}/pull/${n}`;

function mine(
  over: Partial<MyPrRow> & Pick<MyPrRow, "prNumber" | "title" | "headRef">,
): MyPrRow {
  return {
    url: pr(over.prNumber),
    headSha: `${over.prNumber}a0c1d2e3f4a5b6c7`,
    isDraft: false,
    ciState: "success",
    failingChecks: [],
    reviewState: "review_required",
    unaddressedCount: 0,
    needsVerificationCount: 0,
    hasDraftReply: false,
    draftReplyCount: 0,
    health: "green",
    lastActivityAt: ago(30),
    stackId: String(over.prNumber),
    stackPos: 0,
    stackSize: 1,
    reviewThreads: [],
    unpreparedFixRootIds: [],
    incomingFeedback: [],
    ...over,
  };
}

function peer(
  over: Partial<PeerRow> & Pick<PeerRow, "prNumber" | "title" | "author">,
): PeerRow {
  return {
    url: pr(over.prNumber),
    headSha: TOURS[over.prNumber]?.headSha ??
      `${over.prNumber}e9d8c7b6a5f4e3d2`,
    additions: TOURS[over.prNumber]?.additions,
    deletions: TOURS[over.prNumber]?.deletions,
    reason: "new",
    hasDraft: false,
    health: "green",
    ...over,
  };
}

function demoBoard(): PrBoard {
  const myPrs: MyPrRow[] = [
    mine({
      prNumber: 476,
      title: "Extract pricing rules into a PricingPolicy",
      headRef: "you/pricing-policy-1",
      additions: 214,
      deletions: 167,
      stackId: "476-479",
      stackPos: 0,
      stackSize: 2,
      reviewState: "approved",
      issueLinks: [{
        identifier: "SHOP-212",
        title: "Pricing policy refactor",
        url: "https://example.com/issues/SHOP-212",
      }],
    }),
    mine({
      prNumber: 479,
      title: "Apply bulk discounts through PricingPolicy",
      headRef: "you/pricing-policy-2",
      additions: 96,
      deletions: 12,
      stackId: "476-479",
      stackPos: 1,
      stackSize: 2,
      ciState: "failure",
      health: "red",
      failingChecks: [{
        name: "test (node 22)",
        source: "github-actions",
        failureClass: "test",
        detailsUrl: `https://github.com/${REPO}/actions/runs/1`,
      }],
      issueLinks: [{
        identifier: "SHOP-213",
        title: "Bulk discounts",
        url: "https://example.com/issues/SHOP-213",
      }],
    }),
    mine({
      prNumber: 485,
      title: "Show estimated delivery dates on the cart page",
      headRef: "you/delivery-estimate",
      additions: 141,
      deletions: 28,
      unaddressedCount: 1,
      hasDraftReply: true,
      draftReplyCount: 1,
      health: "yellow",
      reviewState: "changes_requested",
      incomingFeedback: [{
        rootId: 9001,
        kind: "inline",
        author: "priya-shah",
        authorType: "human",
        path: "src/web/cart/deliveryEstimate.ts",
        line: 18,
        body:
          "This uses the server's timezone. A shopper in Honolulu at 9pm will see tomorrow's cutoff as today's.",
        createdAt: ago(55),
        status: "likely_unaddressed",
      }],
      reviewThreads: [{
        rootId: 9001,
        path: "src/web/cart/deliveryEstimate.ts",
        line: 18,
        comments: [{
          author: "priya-shah",
          authorType: "human",
          body:
            "This uses the server's timezone. A shopper in Honolulu at 9pm will see tomorrow's cutoff as today's.",
          createdAt: ago(55),
        }],
        diffHunk:
          "@@ -15,4 +15,6 @@\n const cutoff = setHours(new Date(), 15);\n-const shipsToday = now < cutoff;\n+const shipsToday = isBefore(new Date(), cutoff);\n+return shipsToday ? addBusinessDays(now, 2) : addBusinessDays(now, 3);",
        valid: true,
        category: "bug",
        suggestedReply:
          "Good catch. The cutoff is a warehouse time, so I'll compute it in America/Chicago and convert to the shopper's zone for display. Pushing a fix with a test for a Honolulu evening.",
        suggestedFix: {
          files: ["src/web/cart/deliveryEstimate.ts"],
          sketch:
            "Compute the cutoff with zonedTimeToUtc(..., 'America/Chicago').",
        },
        confidence: "high",
        posted: false,
        triageInstance: "triage-485",
      }],
      unpreparedFixRootIds: [9001],
      triageInstance: "triage-485",
      needsYou: {
        kind: "reply",
        summary: "Priya asked about timezones; a reply is drafted",
      },
    }),
  ];
  const peerPrs: PeerRow[] = [
    peer({ prNumber: 482, title: TOURS[482].title, author: "priya-shah" }),
    peer({
      prNumber: 491,
      title: TOURS[491].title,
      author: "sam-okafor",
      reason: "new",
    }),
    peer({
      prNumber: 488,
      title: TOURS[488].title,
      author: "riley-chen",
      reason: "changed",
    }),
    peer({
      prNumber: 487,
      title: "Cache product thumbnails at the CDN edge",
      author: "dana-lopez",
      additions: 58,
      deletions: 9,
      hasDraft: true,
      draftStatus: "drafted",
      needsYou: {
        kind: "reply",
        summary: "Your review draft is ready to send",
      },
    }),
  ];
  const reviewPoolPrs: PeerRow[] = [
    peer({
      prNumber: 493,
      title: "Upgrade the image pipeline to sharp 0.35",
      author: "lee-park",
      additions: 41,
      deletions: 38,
      health: "yellow",
    }),
  ];
  const all = [...myPrs, ...peerPrs, ...reviewPoolPrs];
  return {
    schemaVersion: 1,
    scannedAt: new Date().toISOString(),
    repo: REPO,
    summary: {
      total: all.length,
      red: all.filter((r) => r.health === "red").length,
      yellow: all.filter((r) => r.health === "yellow").length,
      green: all.filter((r) => r.health === "green").length,
      unknown: all.filter((r) => r.health === "unknown").length,
      needsAction: all.filter((r) => r.needsYou).length,
    },
    myPrs,
    peerPrs,
    reviewPoolPrs,
    agentFailures: [],
  };
}

// Tours start built for every PR in TOURS except #482, which the demo builds live.
const builtAt = new Map<number, number>(
  Object.keys(TOURS).map(Number).filter((n) => n !== 482).map((n) => [n, 0]),
);

function tourStates(now: number): TourState[] {
  return [...builtAt].map(([prNumber, readyAt]) => ({
    prNumber,
    pageShas: now >= readyAt && TOURS[prNumber]
      ? [TOURS[prNumber].headSha.slice(0, 12)]
      : [],
    run: now < readyAt
      ? {
        status: "running",
        startedAt: new Date(readyAt - BUILD_MS).toISOString(),
      }
      : undefined,
  }));
}

function board(): PrBoard | null {
  const now = Date.now();
  return enrichBoardWithTours(demoBoard(), tourStates(now), now);
}

const origin = `http://127.0.0.1:${PORT}`;
Deno.serve(
  { hostname: "127.0.0.1", port: PORT },
  createHandler({
    origin,
    board: () => Promise.resolve(board()),
    tour: (file) => {
      const n = Number(file.split(/[.-]/)[0]);
      const readyAt = builtAt.get(n) ?? Infinity;
      const tour = TOURS[n];
      return Promise.resolve(
        tour && Date.now() >= readyAt
          ? new TextEncoder().encode(renderTourPage(tour))
          : null,
      );
    },
    action: (name, body) => {
      const input = JSON.parse(body);
      if (
        name === "pr-tour" && typeof input.prNumber === "number" &&
        TOURS[input.prNumber]
      ) {
        builtAt.set(input.prNumber, Date.now() + BUILD_MS);
      }
      return Promise.resolve(Response.json({ ok: true, demo: true }));
    },
  }),
);

console.log(`PR triage demo (${ME}): http://127.0.0.1:${PORT}/`);
