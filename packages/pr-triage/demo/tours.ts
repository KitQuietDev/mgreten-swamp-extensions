// Fictional tours for the PR triage demo.

import type {
  Hunk,
  Piece,
  Tour,
} from "../../pr-tour/extensions/models/pr_tour.ts";

export const REPO = "acme-co/storefront";

function modified(
  id: string,
  path: string,
  oldStart: number,
  newStart: number,
  lines: string[],
): Hunk {
  const additions = lines.filter((l) => l.startsWith("+")).length;
  const deletions = lines.filter((l) => l.startsWith("-")).length;
  const context = lines.length - additions - deletions;
  return {
    id,
    path,
    status: "modified",
    header: `@@ -${oldStart},${context + deletions} +${newStart},${
      context + additions
    } @@`,
    oldStart,
    newStart,
    patch: lines.join("\n"),
    additions,
    deletions,
  };
}

function added(id: string, path: string, source: string): Hunk {
  const lines = source.replace(/\n$/, "").split("\n").map((l) => `+${l}`);
  return {
    id,
    path,
    status: "added",
    header: `@@ -0,0 +1,${lines.length} @@`,
    oldStart: 0,
    newStart: 1,
    patch: lines.join("\n"),
    additions: lines.length,
    deletions: 0,
  };
}

/** Lines from..to (1-based, inclusive) of `hunk`'s patch. */
function lines(hunk: Hunk, from: number, to: number, note?: string): Piece {
  return { hunkId: hunk.id, from, to, ...(note ? { note } : {}) };
}

function whole(hunk: Hunk, note?: string): Piece {
  return {
    hunkId: hunk.id,
    from: 1,
    to: hunk.patch.split("\n").length,
    ...(note ? { note } : {}),
  };
}

function tour(
  over: Omit<
    Tour,
    | "repo"
    | "url"
    | "additions"
    | "deletions"
    | "provider"
    | "model"
    | "attempts"
    | "baseRef"
  >,
): Tour {
  return {
    repo: REPO,
    url: `https://github.com/${REPO}/pull/${over.prNumber}`,
    baseRef: "main",
    additions: over.hunks.reduce((n, h) => n + h.additions, 0),
    deletions: over.hunks.reduce((n, h) => n + h.deletions, 0),
    provider: "claude",
    model: "claude-sonnet-5-5",
    attempts: 1,
    ...over,
  };
}

// ── #482 Rate limiting: one file, split across four stops ───────────────────

const rlConfig = modified("h1", "src/config.ts", 12, 12, [
  "   port: Number(process.env.PORT ?? 3000),",
  '   databaseUrl: requireEnv("DATABASE_URL"),',
  '   stripeKey: requireEnv("STRIPE_SECRET_KEY"),',
  "+  rateLimit: {",
  "+    checkoutPerMinute: Number(process.env.CHECKOUT_RPM ?? 20),",
  "+    burst: Number(process.env.CHECKOUT_BURST ?? 5),",
  "+  },",
  " };",
  " ",
  " export type Config = typeof config;",
]);

const rlMiddleware = added(
  "h2",
  "src/middleware/rateLimit.ts",
  `import type { NextFunction, Request, Response } from "express";
import { config } from "../config";

type Bucket = { tokens: number; refilledAt: number };

const buckets = new Map<string, Bucket>();

/** Refill a customer's bucket for the time since their last request. */
function refill(bucket: Bucket, now: number): Bucket {
  const perMs = config.rateLimit.checkoutPerMinute / 60_000;
  const tokens = Math.min(
    config.rateLimit.burst,
    bucket.tokens + (now - bucket.refilledAt) * perMs,
  );
  return { tokens, refilledAt: now };
}

export function takeToken(customerId: string, now = Date.now()): boolean {
  const current = buckets.get(customerId) ??
    { tokens: config.rateLimit.burst, refilledAt: now };
  const bucket = refill(current, now);
  if (bucket.tokens < 1) {
    buckets.set(customerId, bucket);
    return false;
  }
  buckets.set(customerId, { ...bucket, tokens: bucket.tokens - 1 });
  return true;
}

export function checkoutRateLimit(req: Request, res: Response, next: NextFunction) {
  const customerId = req.session?.customerId;
  if (!customerId) return next();
  if (takeToken(customerId)) return next();
  res.set("Retry-After", String(retryAfterSeconds(customerId)));
  res.status(429).json({
    error: "too_many_checkout_attempts",
    message: "Slow down, then try checking out again.",
  });
}

export function retryAfterSeconds(customerId: string): number {
  const perMs = config.rateLimit.checkoutPerMinute / 60_000;
  const tokens = buckets.get(customerId)?.tokens ?? 0;
  return Math.ceil((1 - tokens) / perMs / 1000);
}
`,
);

const rlRoute = modified("h3", "src/routes/checkout.ts", 1, 1, [
  ' import { Router } from "express";',
  ' import { createOrder } from "../services/orders";',
  '+import { checkoutRateLimit } from "../middleware/rateLimit";',
  " ",
  " export const checkout = Router();",
  " ",
  '-checkout.post("/checkout", async (req, res) => {',
  '+checkout.post("/checkout", checkoutRateLimit, async (req, res) => {',
  "   const order = await createOrder(req.session.customerId, req.body.cart);",
]);

const rlForm = modified("h4", "src/web/checkoutForm.ts", 41, 41, [
  '   const res = await fetch("/checkout", { method: "POST", body: JSON.stringify(cart) });',
  "+  if (res.status === 429) {",
  '+    const wait = Number(res.headers.get("Retry-After") ?? 5);',
  "+    showToast(`Too many attempts. Try again in ${wait}s.`);",
  "+    return;",
  "+  }",
  "   if (!res.ok) throw new Error(`checkout failed: ${res.status}`);",
]);

const rlTest = added(
  "h5",
  "test/rateLimit.test.ts",
  `import { describe, expect, it } from "vitest";
import { takeToken } from "../src/middleware/rateLimit";

describe("takeToken", () => {
  it("allows a burst, then refuses", () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) expect(takeToken("c1", now)).toBe(true);
    expect(takeToken("c1", now)).toBe(false);
  });

  it("refills over time", () => {
    const now = 2_000_000;
    for (let i = 0; i < 5; i++) takeToken("c2", now);
    expect(takeToken("c2", now + 3_000)).toBe(true);
  });

  it("keeps customers separate", () => {
    const now = 3_000_000;
    for (let i = 0; i < 5; i++) takeToken("c3", now);
    expect(takeToken("c4", now)).toBe(true);
  });
});
`,
);

const rlEnv = modified("h6", ".env.example", 3, 3, [
  " DATABASE_URL=postgres://localhost/storefront",
  " STRIPE_SECRET_KEY=sk_test_replace_me",
  "+CHECKOUT_RPM=20",
  "+CHECKOUT_BURST=5",
]);

const rateLimitTour = tour({
  prNumber: 482,
  title: "Add per-customer rate limiting to checkout",
  author: "priya-shah",
  headRef: "priya/checkout-rate-limit",
  headSha: "4f1c2a9be07d3e55c18a",
  builtAt: new Date(Date.now() - 42 * 60_000).toISOString(),
  summary:
    "Checkout now allows each signed-in customer a burst of 5 attempts, refilling at 20 per minute, and answers 429 with Retry-After when they run out. The limiter is an in-memory token bucket in a new middleware, and the checkout form turns the 429 into a friendly toast.",
  stops: [
    {
      title: "The knobs: limits come from config",
      narrative:
        "Start with the two numbers everything else reads. Both default to something safe and can be tuned per environment without a deploy.",
      pieces: [whole(rlConfig), whole(rlEnv, "Documented for local setups.")],
      reviewFocus: [{
        piece: 1,
        note:
          "A burst of 5 with 20/min is generous for humans; is it tight enough for a card-testing bot?",
      }],
      risk: "low",
    },
    {
      title: "A token bucket per customer",
      narrative:
        "Each customer gets a bucket that refills continuously. takeToken refills first, then spends a token if one is there. Note the map lives in process memory.",
      pieces: [
        lines(
          rlMiddleware,
          1,
          7,
          "Module state: one Map for the whole process.",
        ),
        lines(rlMiddleware, 8, 29, "Refill, then spend."),
      ],
      reviewFocus: [
        {
          piece: 1,
          note:
            "Nothing ever evicts from buckets, so it grows with every customer who checks out. Needs a TTL or an LRU.",
        },
        {
          piece: 1,
          note:
            "In-memory state means each server instance has its own limit; with 4 pods the real limit is 4×.",
        },
      ],
      risk: "medium",
    },
    {
      title: "Wiring it into checkout",
      narrative:
        "The middleware runs in front of the checkout handler. Back in rateLimit.ts, guests without a session pass straight through.",
      pieces: [
        whole(rlRoute),
        lines(
          rlMiddleware,
          30,
          33,
          "Same file, next part: the middleware itself.",
        ),
      ],
      reviewFocus: [{
        piece: 2,
        note:
          "Guest checkout skips the limiter entirely. Is that intended, or should it key on IP?",
      }],
      risk: "medium",
    },
    {
      title: "What the shopper sees",
      narrative:
        "When the bucket is empty the server sends 429 with Retry-After, and the form reads that header to tell the shopper how long to wait.",
      pieces: [
        lines(rlMiddleware, 34, 40, "Back in rateLimit.ts: the 429 response."),
        lines(rlMiddleware, 41, 45),
        whole(rlForm, "The client side of the same contract."),
      ],
      reviewFocus: [],
      risk: "low",
    },
    {
      title: "Tests",
      narrative:
        "Three focused tests cover the burst, the refill, and per-customer isolation. They share module state, so they use distinct customer IDs.",
      pieces: [whole(rlTest)],
      reviewFocus: [{
        piece: 1,
        note: "No test for the 429 response or Retry-After header.",
      }],
      risk: "low",
    },
  ],
  skim: { pieces: [], reason: "" },
  hunks: [rlConfig, rlMiddleware, rlRoute, rlForm, rlTest, rlEnv],
});

// ── #491 Order emails move to a background job ──────────────────────────────

const oeOrders = modified("h1", "src/services/orders.ts", 1, 1, [
  ' import { db } from "../db";',
  '-import { sendOrderEmail } from "../mailer";',
  '+import { enqueue } from "../queue";',
  " ",
  " export async function createOrder(customerId: string, cart: Cart) {",
  "   const order = await db.orders.insert({ customerId, items: cart.items });",
  "-  await sendOrderEmail(order);",
  '+  await enqueue("order-confirmation", { orderId: order.id });',
  "   return order;",
  " }",
]);

const oeJob = added(
  "h2",
  "src/jobs/orderConfirmation.ts",
  `import { db } from "../db";
import { sendOrderEmail } from "../mailer";
import { register } from "../queue";

register("order-confirmation", async ({ orderId }: { orderId: string }) => {
  const order = await db.orders.find(orderId);
  if (!order) return; // deleted before the job ran
  if (order.confirmationSentAt) return; // a retry must not send twice
  await sendOrderEmail(order);
  await db.orders.update(orderId, { confirmationSentAt: new Date() });
});
`,
);

const oeMigration = added(
  "h3",
  "migrations/20261118_add_confirmation_sent_at.sql",
  "ALTER TABLE orders ADD COLUMN confirmation_sent_at timestamptz;\n",
);

const oeQueue = modified("h4", "src/queue.ts", 22, 22, [
  " const worker = new Worker(queueName, async (job) => {",
  "   const handler = handlers.get(job.name);",
  "   if (!handler) throw new Error(`no handler for ${job.name}`);",
  "   await handler(job.data);",
  "-});",
  '+}, { concurrency: 4, attempts: 5, backoff: { type: "exponential", delay: 2_000 } });',
  "+",
  '+import "./jobs/orderConfirmation";',
]);

const oeTest = modified("h5", "test/orders.test.ts", 18, 18, [
  '-  it("emails the customer", async () => {',
  '+  it("queues the confirmation email", async () => {',
  '     const order = await createOrder("c1", cart);',
  "-    expect(mailer.sent).toContainEqual(expect.objectContaining({ orderId: order.id }));",
  '+    expect(queue.jobs).toContainEqual({ name: "order-confirmation", data: { orderId: order.id } });',
  "   });",
]);

const orderEmailTour = tour({
  prNumber: 491,
  title: "Send order confirmation emails from a background job",
  author: "sam-okafor",
  headRef: "sam/order-email-job",
  headSha: "9b03e7d1c4a28f6e0b51",
  builtAt: new Date().toISOString(),
  summary:
    "Checkout used to wait for the mail provider before responding. Now it enqueues an order-confirmation job, and a worker sends the email with retries. A new confirmation_sent_at column keeps retries from emailing twice.",
  stops: [
    {
      title: "Checkout stops waiting on the mailer",
      narrative:
        "createOrder swaps a direct send for an enqueue, so a slow mail provider no longer slows checkout.",
      pieces: [whole(oeOrders)],
      reviewFocus: [{
        piece: 1,
        note:
          "The order insert and the enqueue are not in one transaction; a crash between them loses the email.",
      }],
      risk: "medium",
    },
    {
      title: "The job, and how it avoids double sends",
      narrative:
        "The worker re-reads the order, skips it if the email already went out, then sends and stamps confirmation_sent_at.",
      pieces: [whole(oeJob), whole(oeMigration, "The column the guard reads.")],
      reviewFocus: [{
        piece: 1,
        note:
          "Send happens before the stamp; a crash in between sends twice on retry. Probably fine, but worth a comment.",
      }],
      risk: "medium",
    },
    {
      title: "Retries and registration",
      narrative:
        "The worker gains retry and backoff settings, and imports the job module so its handler registers.",
      pieces: [whole(oeQueue)],
      reviewFocus: [{
        piece: 1,
        note:
          "queue.ts imports the job, and the job imports register from queue.ts: a circular import that works only by load order.",
      }],
      risk: "high",
    },
    {
      title: "Tests",
      narrative:
        "The existing test now asserts on the queue instead of the mailer.",
      pieces: [whole(oeTest)],
      reviewFocus: [{
        piece: 1,
        note: "Nothing exercises the job itself or the double-send guard.",
      }],
      risk: "low",
    },
  ],
  skim: { pieces: [], reason: "" },
  hunks: [oeOrders, oeJob, oeMigration, oeQueue, oeTest],
});

// ── #488 Flaky test fix (small) ─────────────────────────────────────────────

const ftSync = modified("h1", "src/inventory/sync.ts", 30, 30, [
  " export async function syncInventory(clock = systemClock) {",
  "-  const since = new Date(Date.now() - 60_000);",
  "+  const since = new Date(clock.now() - 60_000);",
  "   const changes = await warehouse.changesSince(since);",
]);

const ftTest = modified("h2", "test/inventory/sync.test.ts", 8, 8, [
  ' it("pulls the last minute of changes", async () => {',
  "-  await syncInventory();",
  '+  const clock = fixedClock("2026-11-18T12:00:00Z");',
  "+  await syncInventory(clock);",
  '   expect(warehouse.lastSince).toEqual(new Date("2026-11-18T11:59:00Z"));',
]);

const flakyTour = tour({
  prNumber: 488,
  title: "Fix flaky inventory sync test",
  author: "riley-chen",
  headRef: "riley/inventory-clock",
  headSha: "c7e2a01f9d3b44e8a6f2",
  builtAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  summary:
    "syncInventory read the wall clock even though it accepted an injected one, so its test failed whenever a second ticked over. It now uses the clock it is given.",
  stops: [
    {
      title: "Use the injected clock",
      narrative: "The one-line fix: read time from the clock parameter.",
      pieces: [whole(ftSync)],
      reviewFocus: [],
      risk: "low",
    },
    {
      title: "The test pins time",
      narrative:
        "The test passes a fixed clock, so the expected timestamp is exact.",
      pieces: [whole(ftTest)],
      reviewFocus: [],
      risk: "low",
    },
  ],
  skim: { pieces: [], reason: "" },
  hunks: [ftSync, ftTest],
});

export const TOURS: Record<number, Tour> = {
  482: rateLimitTour,
  488: flakyTour,
  491: orderEmailTour,
};
