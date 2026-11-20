/** Pure board renderer and browser interactions. @module */
import type {
  AgentFailureEvent,
  BoardSummary,
  IncomingFeedbackThread as IncomingFeedbackThreadRow,
  IssueLink,
  MyPrRow,
  PeerRow,
  PrBoard,
  ReviewThreadRow,
} from "../models/board_schema.ts";
function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escape a string for safe embedding inside a single-quoted JS string literal. */
function escJs(s: unknown): string {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/"/g, "\\x22")
    .replace(/&/g, "\\x26")
    .replace(/</g, "\\x3c")
    .replace(/>/g, "\\x3e");
}

/**
 * Every "open this PR" link on the dashboard opens the PR on GitHub, which
 * shows the native stack map for stacked PRs (Graphite was retired on
 * 2026-11-25). `board.repo` is the `owner/repo` slug `gh pr list` returns
 * (e.g. "octo-org/octo-repo").
 */
export function githubPrUrl(repo: string, prNumber: number): string {
  return `https://github.com/${repo}/pull/${prNumber}`;
}

/** Render only canonical issue links already resolved by the board model. */
function renderIssueLinks(issues: IssueLink[] | undefined): string {
  if (!issues?.length) return "";
  return `<div class="linear-links">${
    issues.map((issue) =>
      `<a class="pill pill-linear" href="${
        esc(issue.url)
      }" target="_blank" rel="noopener" title="${esc(issue.title)}">${
        esc(issue.identifier)
      } ↗</a>`
    ).join("")
  }</div>`;
}

// ---------------------------------------------------------------------------
// ACTION-BUTTON TRANSPORT (Phase 3 — wired: webhook fetch, peer lane only)
export type ActionKind =
  | "peer-review"
  | "peer-dismiss"
  | "post-reply"
  | "tweak"
  | "prepare-selected-fixes"
  | "accept-push"
  | "approve-push-reply"
  | "post-selected-replies"
  | "post-thread-reply"
  | "decision-redraft"
  | "mark-agent-failures-read"
  | "tour";

const HOOKS_PREFIX = "/actions";

/**
 * The same-origin POST URL an action button targets. Single swappable
 * transport seam: the button POSTs its body (`{prNumber}` for the peer-lane
 * actions, `{prNumber, instruction}` for a My-PR tweak) to this URL and the
 * browser sends it unsigned; the server signs it for the webhook.
 */
export function actionFor(_prNumber: number, kind: ActionKind): string {
  const route = kind === "peer-review"
    ? "pr-peer-review"
    : kind === "peer-dismiss"
    ? "pr-peer-dismiss"
    : kind === "post-reply"
    ? "pr-post-reply"
    : kind === "prepare-selected-fixes"
    ? "pr-prepare-selected-fixes"
    : kind === "accept-push"
    ? "pr-accept-push"
    : kind === "approve-push-reply"
    ? "pr-approve-push-reply"
    : kind === "post-selected-replies"
    ? "pr-post-selected-replies"
    : kind === "post-thread-reply"
    ? "pr-post-thread-reply"
    : kind === "decision-redraft"
    ? "pr-decision-redraft"
    : kind === "mark-agent-failures-read"
    ? "pr-mark-agent-failures-read"
    : kind === "tour"
    ? "pr-tour"
    : "pr-tweak";
  return `${HOOKS_PREFIX}/${route}`;
}

export function humanizeHookError(status: number, text: string): string {
  const trimmed = String(text ?? "").trim();
  if (trimmed.startsWith("<")) {
    return `Webhook unavailable (HTTP ${status})`;
  }
  return `Failed (HTTP ${status}): ${trimmed}`;
}

// ---------------------------------------------------------------------------
// Presentational helpers (pure)
// ---------------------------------------------------------------------------

/** Health sort rank — red first so problems surface at the top. */
const HEALTH_RANK: Record<string, number> = {
  red: 0,
  yellow: 1,
  green: 2,
  unknown: 3,
};

/** Order recognized health states; unknown values sort last. */
export function healthRank(health: string): number {
  return HEALTH_RANK[String(health ?? "unknown").toLowerCase()] ?? 9;
}

function healthOf(row: { health?: string }): string {
  return String(row.health ?? "unknown").toLowerCase();
}

/** Order rows health-first (red → yellow → green → unknown), then by prNumber. */
function sortByHealthThenPr<T extends { health?: string; prNumber: number }>(
  rows: T[],
): T[] {
  return [...rows].sort((a, b) => {
    const ra = healthRank(healthOf(a));
    const rb = healthRank(healthOf(b));
    if (ra !== rb) return ra - rb;
    return a.prNumber - b.prNumber;
  });
}

// ---------------------------------------------------------------------------
// Stack grouping (pure) — My PRs lane
// ---------------------------------------------------------------------------

/** A `myPrs` row grouped by `stackId`, ready to render as one unit. */
export interface StackGroup {
  stackId: string;
  size: number;
  worstHealth: string;
  /**
   * Member rows ordered TOP-to-bottom for display: highest `stackPos` first,
   * `stackPos` 0 (the base PR) last. `stackPos` itself is bottom-to-top
   * (0 = base) per the pr-triage-board contract, so this is the reverse of
   * that — it mirrors how GitHub's stack map shows a stack, top layer first.
   */
  rows: MyPrRow[];
}

/**
 * Group `myPrs` rows by `stackId` into `StackGroup`s for rendering.
 *
 * Within a stack: rows are ordered top-to-bottom by DESCENDING `stackPos`
 * (see `StackGroup.rows` doc above).
 *
 * Across stacks: ordered by the stack's WORST (lowest-rank) member health —
 * a stack with any red row sorts before an all-yellow stack, which sorts
 * before an all-green/unknown stack — via `healthRank`. Ties break by the
 * stack's highest PR number descending (most-recently-opened stack first);
 * PR numbers are monotonically increasing in this repo, so the max member
 * PR is a reasonable proxy for stack recency without needing a separate
 * "opened at" field. Singleton "stacks" (size 1) participate in this same
 * ordering — they are just groups of one and get no visual container.
 */
export function groupIntoStacks(myPrs: MyPrRow[]): StackGroup[] {
  const byStack = new Map<string, MyPrRow[]>();
  for (const row of myPrs) {
    const key = row.stackId ?? `solo-${row.prNumber}`;
    const bucket = byStack.get(key);
    if (bucket) bucket.push(row);
    else byStack.set(key, [row]);
  }

  const groups: StackGroup[] = [];
  for (const [stackId, rows] of byStack) {
    const orderedRows = [...rows].sort((a, b) => b.stackPos - a.stackPos);
    const worstRank = Math.min(...rows.map((r) => healthRank(healthOf(r))));
    const worstHealth = Object.keys(HEALTH_RANK).find((h) =>
      HEALTH_RANK[h] === worstRank
    ) ?? "unknown";
    groups.push({ stackId, size: rows.length, worstHealth, rows: orderedRows });
  }

  return groups.sort((a, b) => {
    const ra = healthRank(a.worstHealth);
    const rb = healthRank(b.worstHealth);
    if (ra !== rb) return ra - rb;
    const maxA = Math.max(...a.rows.map((r) => r.prNumber));
    const maxB = Math.max(...b.rows.map((r) => r.prNumber));
    return maxB - maxA;
  });
}

/**
 * A compact human "N ago" relative time. Pure over an explicit `now` (ms) so
 * tests are deterministic. Returns "" for a null/invalid input.
 */
export function relativeTime(
  iso: string | null | undefined,
  nowMs: number,
): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const deltaMs = t - nowMs;
  const past = deltaMs <= 0;
  const s = Math.abs(deltaMs) / 1000;
  const unit = s < 90
    ? `${Math.round(s)}s`
    : s < 90 * 60
    ? `${Math.round(s / 60)}m`
    : s < 36 * 3600
    ? `${Math.round(s / 3600)}h`
    : `${Math.round(s / 86400)}d`;
  return past ? `${unit} ago` : `in ${unit}`;
}

const CI_BADGE_CLASS: Record<string, string> = {
  failure: "badge-ci-red",
  pending: "badge-ci-amber",
  success: "badge-ci-green",
  neutral: "badge-ci-green",
  unknown: "badge-ci-unknown",
};

const REVIEW_PILL_CLASS: Record<string, string> = {
  approved: "pill-review-approved",
  changes_requested: "pill-review-changes-requested",
  commented: "pill-review-commented",
  pending: "pill-review-pending",
};

function healthDotClass(h: string): string {
  return h === "red"
    ? "dot-red"
    : h === "yellow"
    ? "dot-amber"
    : h === "green"
    ? "dot-green"
    : "dot-unknown";
}

// ---------------------------------------------------------------------------
// Card render (pure) — My PRs
// ---------------------------------------------------------------------------

/** "base" for the bottom PR, "#N of M" (1-based from the top) otherwise. Empty for a singleton. */
function stackPositionLabel(row: MyPrRow): string {
  if (row.stackSize <= 1) return "";
  if (row.stackPos === 0) return "base";
  const fromTop = row.stackSize - row.stackPos; // 1-based, top PR = 1
  return `#${fromTop} of ${row.stackSize}`;
}

/**
 * "Accept & push" button shown once a tweak/cifix run has a non-empty diff —
 * regardless of whether the run's OWN agent invocation reported success,
 * since a human who has read the diff and judges it good enough is the
 * actual gate here, not that flag (acceptPush re-verifies mechanically
 * before it ever pushes regardless). POSTs `{prNumber, kind}` to
 * /pr-hooks/pr-accept-push via `fireAcceptPush` (confirm()-gated — it
 * commits and pushes to the PR's own branch on a green local check).
 */
function renderAcceptPushButton(
  row: MyPrRow,
  kind: "tweak" | "cifix",
  changedFiles: number,
): string {
  const pushed = kind === "cifix" ? row.ciFixPushed : row.tweakPushed;
  if (changedFiles <= 0 || pushed === true) {
    return "";
  }
  return `<button class="pbtn pbtn-accept" onclick="fireAcceptPush(${row.prNumber}, '${kind}', this)">Verify &amp; push → origin/${
    esc(row.headRef)
  }</button>`;
}

function renderAcceptStatus(row: MyPrRow, kind: "tweak" | "cifix"): string {
  const pushed = kind === "cifix" ? row.ciFixPushed : row.tweakPushed;
  const summary = kind === "cifix"
    ? row.ciFixPushSummary
    : row.tweakPushSummary;
  const state = pushed === true ? "pushed" : pushed === false ? "failed" : "";
  const resultClass = pushed === true
    ? " result-success"
    : pushed === false
    ? " result-error"
    : "";
  return `<div class="action-result${resultClass}" data-role="accept-${kind}-status"${
    state ? ` data-accept-push-state="${state}"` : ""
  } aria-live="polite">${esc(summary ?? "")}</div>`;
}

function activeFixKind(row: MyPrRow): "tweak" | "cifix" {
  if (
    row.hasCiFix && row.ciFixChangedFiles !== 0 && row.ciFixPushed !== true
  ) return "cifix";
  if (
    row.hasTweak && row.tweakChangedFiles !== 0 && row.tweakPushed !== true
  ) return "tweak";
  if (row.hasCiFix && row.ciFixPushed !== true) return "cifix";
  return row.hasCiFix && !row.hasTweak ? "cifix" : "tweak";
}

function combinedFixReplyAction(row: MyPrRow): {
  button: string;
  pushButton: string;
  status: string;
} {
  const kind = activeFixKind(row);
  const hasUnpushedFix =
    (row.hasTweak === true && row.tweakChangedFiles !== 0 &&
      row.tweakPushed !== true) ||
    (row.hasCiFix === true && row.ciFixChangedFiles !== 0 &&
      row.ciFixPushed !== true);
  const firstUnposted = row.reviewThreads.find((thread) => !thread.posted);
  const hasNewerFixableFeedback = hasUnpushedFix &&
    (row.unpreparedFixRootIds ?? []).length > 0;
  if (hasNewerFixableFeedback) {
    return {
      button: "",
      pushButton: "",
      status:
        `<div class="action-result result-error" data-role="accept-${kind}-status" data-accept-push-state="stale" aria-live="polite">This held diff does not include all fixable feedback. Prepare fixes again before pushing.</div>`,
    };
  }
  if (!hasUnpushedFix || !firstUnposted) {
    const pushed = kind === "cifix" ? row.ciFixPushed : row.tweakPushed;
    return {
      button: "",
      pushButton: "",
      status: pushed == null ? "" : renderAcceptStatus(row, kind),
    };
  }

  const changedFiles = kind === "cifix"
    ? row.ciFixChangedFiles ?? 0
    : row.tweakChangedFiles ?? 0;
  return {
    button:
      `<button class="pbtn pbtn-accept" onclick="fireApprovePushAndReply(${row.prNumber}, '${kind}', this)">Approve, push &amp; selected replies</button>`,
    pushButton: renderAcceptPushButton(row, kind, changedFiles),
    status: renderAcceptStatus(row, kind),
  };
}

/**
 * Render every drafted thread reply on this PR's card: the reviewer's
 * original path/line, the drafted reply text, a confidence pill, and
 * either a "Post reply" button (not yet posted) or a "posted ✓" state
 * (never re-postable — postReply itself refuses a double-post, but the
 * button also disappearing once posted keeps the card from inviting a
 * doomed click). Empty when `reviewThreads` is empty (never reviewed yet,
 * or reviewed with nothing outstanding).
 */
/** First line of a string, truncated to `max` chars — used for a thread's collapsed one-line summary. */
function firstLineTruncated(text: string, max: number): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

const CATEGORY_LABEL: Record<string, string> = {
  agree: "Agree",
  disagree: "Disagree",
  needs_question: "Question",
  already_handled: "Already handled",
};

/**
 * Render the ORIGINAL review conversation a drafted reply is responding to
 * — every comment in the thread, oldest first (mirrors buildReviewPrompt's
 * own ordering so what you read here is exactly what the agent saw). Each
 * comment shows its author + a bot/human pill so an AI reviewer's finding
 * (e.g. claude[bot]) is never mistaken for a teammate's.
 */
function renderThreadComments(comments: ReviewThreadRow["comments"]): string {
  if (comments.length === 0) return "";
  const items = comments.map((c) => `
            <div class="review-thread-comment">
              <div class="review-thread-comment-meta"><strong>${
    esc(c.author)
  }</strong> <span class="pill pill-author-${esc(c.authorType)}">${
    esc(c.authorType)
  }</span></div>
              <div class="review-thread-comment-body">${esc(c.body)}</div>
            </div>`).join("\n");
  return `<div class="review-thread-conversation">${items}</div>`;
}

/**
 * One thread as a collapsible `<details>` — collapsed by default (mobile-
 * friendly; a PR can have 7+ threads and showing full context for all of
 * them at once is a long scroll). The `<summary>` is a compact one-liner
 * (location, category, first line of the reviewer's comment); opening it
 * reveals the full original conversation, the diff hunk it's anchored to,
 * the clearly-labelled NOT-YET-APPLIED fix sketch (selectable for the card's
 * Prepare selected fixes action), and an editable reply pre-selected for the
 * card's combined send. `toggleThreadAccordion` (see
 * SCRIPT) closes any other open thread on this card when one opens, so only
 * one thread's full context is on screen at a time. This is the ✉ Reply-to-
 * send card's per-thread body. Fix and reply selection are deliberately
 * separate: a thread can contribute a code fix without sending its reply,
 * or send a reply without contributing a fix sketch.
 */
function renderReviewThread(row: MyPrRow, t: ReviewThreadRow): string {
  const location = t.line != null ? `${esc(t.path)}:${t.line}` : esc(t.path);
  const categoryLabel = CATEGORY_LABEL[t.category] ?? t.category;
  const firstComment = t.comments[0];
  const summaryPreview = firstComment
    ? firstLineTruncated(firstComment.body, 70)
    : "";

  const fixSketch = t.suggestedFix
    ? `
            <div class="review-thread-fix">
              <div class="review-thread-fix-label">Suggested fix sketch — not applied yet</div>
              <div class="review-thread-fix-files">${
      esc(t.suggestedFix.files.join(", "))
    }</div>
              <div class="review-thread-fix-sketch">${
      esc(t.suggestedFix.sketch)
    }</div>
              <label class="review-thread-select"><input type="checkbox" data-role="fix-select-${t.rootId}" data-triage-instance="${
      esc(t.triageInstance)
    }" checked> Include in prepared code fix</label>
            </div>`
    : "";

  const diffBlock = t.diffHunk
    ? `<details class="review-thread-diff"><summary>Diff hunk</summary><pre>${
      esc(t.diffHunk)
    }</pre></details>`
    : "";

  const footer = t.posted
    ? `<span class="signal badge-tweak-ok">posted ✓${
      t.postedBody && t.postedBody !== t.suggestedReply ? " (edited)" : ""
    }</span>`
    : `
            <div class="review-thread-reply-row">
              <label class="review-thread-select"><input type="checkbox" data-role="reply-select-${t.rootId}" data-triage-instance="${
      esc(t.triageInstance)
    }" checked> Include in combined reply</label>
              <textarea class="review-thread-reply-textarea" data-role="reply-text-${t.rootId}" rows="4">${
      esc(t.suggestedReply)
    }</textarea>
              <div class="review-thread-actions">
                <button class="pbtn pbtn-post-thread" onclick="firePostThreadReply('${
      escJs(t.triageInstance)
    }', ${t.rootId}, ${row.prNumber}, this)">Post this reply</button>
              </div>
            </div>`;

  // A posted reply is normally addressed, but keep it visible while its
  // selected code fix has not been represented by a successful tweak run.
  const hasUnpreparedFix = (row.unpreparedFixRootIds ?? []).includes(t.rootId);
  const addressedClass = t.posted && !hasUnpreparedFix ? " is-addressed" : "";
  const replyOnlyCue = !t.posted && t.suggestedFix == null
    ? `<div class="review-thread-reply-only">Reply only — no code fix suggested for this thread</div>`
    : "";
  return `
          <details class="review-thread${addressedClass}" data-root-id="${t.rootId}" ontoggle="toggleThreadAccordion(this)">
            <summary>
              <code>${location}</code>
              <span class="pill pill-confidence-${esc(t.confidence)}">${
    esc(categoryLabel)
  }</span>
              <span class="review-thread-summary-preview">${
    esc(summaryPreview)
  }</span>
            </summary>
            <div class="review-thread-body">
              ${renderThreadComments(t.comments)}
              ${diffBlock}
              ${fixSketch}
              ${replyOnlyCue}
              ${footer}
              <div class="action-result" data-role="post-reply-status-${t.rootId}" aria-live="polite"></div>
            </div>
          </details>`;
}

function renderReviewThreads(row: MyPrRow): string {
  if (row.reviewThreads.length === 0) return "";
  const items = row.reviewThreads.map((t) => renderReviewThread(row, t)).join(
    "\n",
  );
  // A posted reply is addressed; heading counts the un-posted (actionable)
  // drafts, with a muted "+N posted" hint, and the whole block hides when every
  // draft has been posted. Same discipline as renderIncomingFeedback.
  const postedCount = row.reviewThreads.filter((t) => t.posted).length;
  const actionableCount =
    row.reviewThreads.filter((t) =>
      !t.posted || (row.unpreparedFixRootIds ?? []).includes(t.rootId)
    ).length;
  const allAddressed = actionableCount === 0;
  const blockAddressedClass = allAddressed ? " is-addressed" : "";
  const postedHint = postedCount > 0
    ? ` <span class="addressed-hint">+${postedCount} posted</span>`
    : "";
  return `
        <div class="review-threads-block${blockAddressedClass}">
          <div class="review-threads-heading">Drafted replies (${actionableCount})${postedHint}</div>
          ${items}
        </div>`;
}

const INCOMING_STATUS_LABEL: Record<string, string> = {
  likely_unaddressed: "unaddressed",
  addressed_by_commit: "to verify",
  likely_addressed: "addressed",
};

/**
 * One incoming reviewer thread as a collapsed `<details>` — mirrors
 * `renderReviewThread`'s accordion shape but for the RAW comment, before any
 * AI review pass. The `<summary>` always shows author, location, a bot/human
 * pill, and a first-line preview so the gist is visible without expanding;
 * opening it reveals the full (already-truncated-upstream) body via the same
 * `review-thread-comment*` classes `renderThreadComments` uses, so styling
 * matches the drafted-reply threads exactly.
 */
/**
 * True for an incoming thread the "Hide addressed" filter should hide:
 * `likely_addressed` only. `addressed_by_commit` ("to verify") is deliberately
 * NOT addressed — a commit that MIGHT have handled the feedback isn't proof
 * (rebase/squash false-positives happen), so those stay visible.
 */
function isIncomingAddressed(t: IncomingFeedbackThreadRow): boolean {
  return t.status === "likely_addressed";
}

function renderIncomingFeedbackThread(t: IncomingFeedbackThreadRow): string {
  const location = t.line != null ? `${esc(t.path)}:${t.line}` : esc(t.path);
  const statusLabel = INCOMING_STATUS_LABEL[t.status] ?? t.status;
  const preview = firstLineTruncated(t.body, 70);
  const addressedClass = isIncomingAddressed(t) ? " is-addressed" : "";
  return `
          <details class="review-thread incoming-feedback-thread${addressedClass}" data-root-id="${t.rootId}">
            <summary>
              <strong>${esc(t.author)}</strong>
              <span class="pill pill-author-${esc(t.authorType)}">${
    esc(t.authorType)
  }</span>
              <code>${location}</code>
              <span class="pill pill-incoming-status-${esc(t.status)}">${
    esc(statusLabel)
  }</span>
              <span class="review-thread-summary-preview">${esc(preview)}</span>
            </summary>
            <div class="review-thread-body">
              <div class="review-thread-conversation">
                <div class="review-thread-comment">
                  <div class="review-thread-comment-meta"><strong>${
    esc(t.author)
  }</strong> <span class="pill pill-author-${esc(t.authorType)}">${
    esc(t.authorType)
  }</span></div>
                  <div class="review-thread-comment-body">${esc(t.body)}</div>
                </div>
              </div>
            </div>
          </details>`;
}

/**
 * Render incoming reviewer comments that do not yet have a drafted reply. Raw
 * feedback remains visible before any AI review pass, but once a matching
 * `reviewThreads` row exists that richer section owns the thread and avoids
 * repeating the same comment twice on one card.
 */
function renderIncomingFeedback(row: MyPrRow): string {
  const draftedRootIds = new Set(row.reviewThreads.map((t) => t.rootId));
  const incomingFeedback = row.incomingFeedback.filter((t) =>
    !draftedRootIds.has(t.rootId)
  );
  if (incomingFeedback.length === 0) return "";
  const items = incomingFeedback.map(renderIncomingFeedbackThread).join(
    "\n",
  );
  const addressedCount = incomingFeedback.filter(isIncomingAddressed).length;
  const actionableCount = incomingFeedback.length - addressedCount;
  // The heading counts ACTIONABLE items (what's left when addressed is hidden);
  // a muted "+N addressed" hint keeps the hidden total honest. The block itself
  // carries `is-addressed` only when EVERY item is addressed, so an all-clear
  // PR's whole "Incoming feedback" block (heading included) disappears under the
  // filter rather than leaving a bare "(0)" heading behind.
  const allAddressed = actionableCount === 0;
  const blockAddressedClass = allAddressed ? " is-addressed" : "";
  const addressedHint = addressedCount > 0
    ? ` <span class="addressed-hint">+${addressedCount} addressed</span>`
    : "";
  return `
        <div class="review-threads-block incoming-feedback-block${blockAddressedClass}">
          <div class="review-threads-heading">Incoming feedback (${actionableCount})${addressedHint}</div>
          ${items}
        </div>`;
}

/**
 * A slim STATUS ROW for a My-PR card — the calm-redesign replacement for the
 * old dense card. NO buttons, NO tweak box, NO inline threads: just
 * prNumber/title, a health dot, the stack-position pill, GitHub's review
 * state, CI state, last-activity, and a FADING "auto-fixed CI ✓" badge when a
 * recent successful auto-fix exists (reusing the tweak/ciFix agentSuccess
 * signal for now — see `renderAutoFixBadge`'s doc; a real auto-fix pipeline is
 * a later phase). A PR with `needsYou` set never reaches this renderer at all
 * — `renderLaneBodies` filters those OUT into the Needs-you queue before the
 * My PRs lane is built (see that function's doc).
 *
 * `standalone` is true for a size-1 "stack" (a bare row sitting directly in
 * the grid) and false for a member of a real multi-PR stack (nested inside
 * `.stack-members`). Only a standalone row gets its OWN click-to-expand
 * header — a stack-member row expands as part of its whole stack (see
 * `renderStackGroup`'s header), never individually, so clicking one PR deep
 * in a 3-PR stack doesn't leave the other two oddly sized.
 */
function renderMyPrCard(
  row: MyPrRow,
  nowMs: number,
  repo: string,
  standalone = true,
): string {
  const h = healthOf(row);
  const draftPill = row.isDraft
    ? `<span class="pill pill-draft">DRAFT</span>`
    : "";
  // Keep GitHub's review summary visible beside CI so "SUCCESS" cannot be
  // mistaken for approval to merge.
  const reviewState = row.reviewState.toLowerCase();
  const reviewPillClass = REVIEW_PILL_CLASS[reviewState] ??
    "pill-review-pending";
  const reviewPill =
    `<span class="pill pill-review ${reviewPillClass}">review: ${
      esc(reviewState.replaceAll("_", " "))
    }</span>`;
  const ciClass = CI_BADGE_CLASS[row.ciState] ?? "badge-ci-unknown";

  const activity = row.lastActivityAt
    ? `<div class="card-activity">last activity ${
      esc(relativeTime(row.lastActivityAt, nowMs) || "—")
    }</div>`
    : "";

  const posLabel = stackPositionLabel(row);
  const posPill = posLabel
    ? `<span class="pill pill-stack-pos">${esc(posLabel)}</span>`
    : "";

  const expandAttr = standalone ? ` onclick="toggleEntryExpand(this)"` : "";
  const expandHint = standalone
    ? `<span class="stack-expand-hint">(tap to expand)</span>`
    : "";
  const prUrl = githubPrUrl(repo, row.prNumber);
  const preparation = row.fixPreparation?.status === "running"
    ? `<div class="fix-preparation fix-preparation-running">⟳ Preparing selected fixes… Replies remain queued in this browser.</div>`
    : "";
  return `
      <article class="card card-slim health-${esc(h)}" data-health="${
    esc(h)
  }" data-pr="${row.prNumber}" data-triage-instance="${
    esc(row.triageInstance ?? "")
  }" data-head-ref="${esc(row.headRef)}">
        <header class="card-head"${expandAttr}>
          <div class="card-title">
            <span class="dot ${healthDotClass(h)}" aria-hidden="true"></span>
            <a class="card-link" href="${
    esc(prUrl)
  }" target="_blank" rel="noopener" onclick="event.stopPropagation()">${
    esc(row.title)
  }</a>
            ${expandHint}
          </div>
          ${renderPrNumber(row)}
        </header>
        <div class="card-badges">
          ${posPill}
          ${draftPill}
          ${reviewPill}
          <span class="badge ${ciClass}">${esc(row.ciState)}</span>
        </div>
        ${activity}
        ${preparation}
        ${renderAutoFixBadge(row)}
        <div class="card-footer card-footer-slim">
          <a class="link-action" href="${
    esc(prUrl)
  }" target="_blank" rel="noopener">Open PR ↗</a>
          ${renderTourControl(row)}
          ${renderIssueLinks(row.issueLinks)}
        </div>
      </article>`;
}

/**
 * The fading "⤷ auto-fixed CI ✓ (N ago)" badge on a calm My-PR row — the ONLY
 * trace a silent auto-fix leaves on a status row, per the redesign plan's
 * "silent-fix trace" decision. Phase 1 doesn't have a real auto-fix pipeline
 * yet (that's Phase 3), so this REUSES the existing tweak/ciFix
 * `agentSuccess` signal as a stand-in: a row only reaches this renderer when
 * `needsYou` is unset, and `needsYou`'s "glance" kind already claims every
 * successful-but-unpushed fix (see `deriveNeedsYou`), so the only
 * agentSuccess case left ON A CALM ROW is one that HAS since been pushed
 * (`tweakPushed === true`) — exactly the "the machine already acted, here's
 * the fading trace" moment this badge is for. Once CI fails again (or is
 * pending), hide the old success trace; a prior push is not a current CI pass.
 */
function renderAutoFixBadge(row: MyPrRow): string {
  if (row.ciState !== "success") return "";
  const tweakPushed = row.tweakAgentSuccess === true &&
    row.tweakPushed === true;
  const ciFixPushed = row.ciFixAgentSuccess === true &&
    row.ciFixPushed === true;
  if (tweakPushed || ciFixPushed) {
    const ranAt = ciFixPushed ? row.ciFixRanAt : row.tweakRanAt;
    const when = ranAt
      ? ` <span class="autofix-when">(${
        esc(relativeTime(ranAt, Date.now()) || ranAt)
      })</span>`
      : "";
    return `<div class="autofix-badge">⤷ auto-fixed CI ✓${when}</div>`;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Stack group render (pure) — My PRs lane
// ---------------------------------------------------------------------------

/**
 * Render one `StackGroup`. A multi-PR stack gets a bordered container with a
 * left accent rail and a small "N-PR stack" header, its member rows butted
 * together inside (no gap) so it reads as "these move together." A
 * singleton (size 1) renders as a bare standalone row — a stack-of-1 header
 * would just be noise. The header carries NO action buttons in the calm
 * redesign — grouping only, click-to-expand only.
 */
function renderStackGroup(
  group: StackGroup,
  nowMs: number,
  repo: string,
): string {
  if (group.size <= 1) {
    return renderMyPrCard(group.rows[0], nowMs, repo);
  }
  const cards = group.rows.map((r) => renderMyPrCard(r, nowMs, repo, false))
    .join("\n");
  return `
      <div class="stack-group stack-health-${
    esc(group.worstHealth)
  }" data-stack-id="${esc(group.stackId)}">
        <div class="stack-header-block">
          <div class="stack-header" onclick="toggleEntryExpand(this.closest('.stack-group'))">
            <span class="stack-header-label">⌗ Stack of ${group.size} <span class="stack-expand-hint">(tap to expand)</span></span>
          </div>
        </div>
        <div class="stack-members">${cards}</div>
      </div>`;
}

// ---------------------------------------------------------------------------
// Row render (pure) — Peer / review-pool PRs (calm tier)
// ---------------------------------------------------------------------------

/**
 * A slim calm row for a Peer/review-pool PR — the calm-redesign replacement
 * for the old action-button card (repurposes the former `renderPeerCard`; the
 * name changed to `renderPeerRow` to make the "no actions here" contract
 * explicit). A row with `hasDraft` true NEVER reaches this renderer:
 * `renderLaneBodies` absorbs it UP into the Needs-you queue as a ✉ card
 * before either lane is built (see `derivePeerRow`'s `needsYou` wiring and
 * `renderLaneBodies`'s doc) — so `draftBlock` here only ever needs to show
 * "no draft yet," never a ready one.
 */
function renderPeerRow(row: PeerRow, repo: string): string {
  const h = healthOf(row);
  const reasonPill = `<span class="pill pill-reason-${esc(row.reason)}">${
    esc(row.reason)
  }</span>`;
  const prUrl = githubPrUrl(repo, row.prNumber);
  return `
      <article class="card card-slim health-${esc(h)}" data-health="${
    esc(h)
  }" data-pr="${row.prNumber}">
        <header class="card-head">
          <div class="card-title">
            <span class="dot ${healthDotClass(h)}" aria-hidden="true"></span>
            <a class="card-link" href="${
    esc(prUrl)
  }" target="_blank" rel="noopener">${esc(row.title)}</a>
          </div>
          ${renderPrNumber(row)}
        </header>
        <div class="card-badges">
          <span class="pill pill-author">${esc(row.author)}</span>
          ${reasonPill}
        </div>
        <div class="card-footer card-footer-slim">
          <a class="link-action" href="${
    esc(prUrl)
  }" target="_blank" rel="noopener">Open PR ↗</a>
          ${renderTourControl(row)}
          ${renderIssueLinks(row.issueLinks)}
        </div>
        <div class="action-result" data-role="result" aria-live="polite"></div>
      </article>`;
}

/**
 * The Tour control on a peer or review-pool card. The page lives beside the
 * dashboard , so its link is same-origin.
 * Building fires the /pr-hooks/pr-tour webhook; a push makes an existing
 * tour stale, and Rebuild tours the new head.
 */
/** The PR number with its +added / −deleted line counts underneath, when known. */
function renderPrNumber(
  row: { prNumber: number; additions?: number; deletions?: number },
): string {
  const size = row.additions == null || row.deletions == null
    ? ""
    : `<span class="pr-size" title="lines added and deleted"><span class="pr-add">+${row.additions}</span> <span class="pr-del">−${row.deletions}</span></span>`;
  return `<span class="pr-number">#${row.prNumber}${size}</span>`;
}

function renderTourControl(
  row: { prNumber: number; tour?: TourStatus },
): string {
  const href = `/tours/${row.prNumber}.html`;
  const fire = (label: string) =>
    `<button class="pbtn pbtn-tour" onclick="fireTour(${row.prNumber}, this)">${label}</button>`;
  const body = row.tour === "ready"
    ? `<a class="link-action" href="${href}" target="_blank" rel="noopener">🧭 Open tour</a>`
    : row.tour === "building"
    ? `<span class="tour-building">🧭 Building tour…</span>`
    : row.tour === "stale"
    ? `<a class="link-action tour-stale" href="${href}" target="_blank" rel="noopener" title="Built for an earlier push">🧭 Older tour</a>${
      fire("Rebuild")
    }`
    : row.tour === "failed"
    ? fire("🧭 Retry tour")
    : fire("🧭 Tour");
  return `<span class="tour-actions" data-tour-state="${
    row.tour ?? "none"
  }">${body}</span>`;
}

// ---------------------------------------------------------------------------
// Needs-you queue (pure) — the ✉ Reply-to-send / ⚠ Decision-needed cards
// ---------------------------------------------------------------------------
// A row (My-PR or Peer/Pool) with `needsYou` set is pulled OUT of its home
// lane and rendered here instead — see `renderLaneBodies`'s partitioning doc.
// Two card shapes, chosen by `needsYou.kind`:
//   "reply"              -> renderReplyCard    (✉ Reply to send)
//   "decision" | "glance" -> renderDecisionCard (⚠ Decision needed)

/** True when `row` is a MyPrRow (has the fields only a My-PR row carries). */
function isMyPrRow(row: MyPrRow | PeerRow): row is MyPrRow {
  return "reviewThreads" in row;
}

/** Render a unified diff with review-friendly line coloring, without external assets. */
function renderCodeDiff(diff: string): string {
  return diff.split("\n").map((line) => {
    const kind = line.startsWith("@@")
      ? "hunk"
      : line.startsWith("+") && !line.startsWith("+++")
      ? "add"
      : line.startsWith("-") && !line.startsWith("---")
      ? "remove"
      : line.startsWith("diff --git ") || line.startsWith("index ") ||
          line.startsWith("---") || line.startsWith("+++")
      ? "meta"
      : "context";
    return `<span class="diff-line diff-${kind}">${esc(line)}</span>`;
  }).join("\n");
}

/**
 * ✉ Reply-to-send card: reviewer comment(s) + the fix diff-stat (collapsed) +
 * a terse summary line + an editable reply textarea + [Approve & send]
 * [Edit] [Dismiss], plus a CONTEXTUAL collapsed prepare/refine box (the
 * ONLY surviving tweak input — see `renderRefineBox`'s doc). Reuses the
 * EXISTING `renderReviewThreads`/`renderIncomingFeedback` accordions for a
 * My-PR row (unchanged, full context on demand) — a Peer/Pool row has no
 * per-thread data on the board yet, so it shows the terse `needsYou.summary`
 * plus a link out to the draft instead.
 *
 * [Edit] is simply "the textarea below is already editable" — no separate
 * mode, mirroring `renderReviewThread`'s existing editable-textarea contract;
 * [Dismiss] removes the card from view client-side (same mechanic as the old
 * peer-dismiss — no server round-trip needed for a pure "not now," since the
 * NEXT scan will re-derive `needsYou` from the same still-true signals if it
 * still applies; a real per-item dismiss-memory is a later-phase refinement).
 */
function renderReplyCard(row: MyPrRow | PeerRow, repo: string): string {
  const h = healthOf(row);
  const prUrl = githubPrUrl(repo, row.prNumber);
  const summary = row.needsYou?.summary
    ? `<div class="needsyou-summary">${esc(row.needsYou.summary)}</div>`
    : "";
  const preparationFailure = isMyPrRow(row) &&
      row.fixPreparation?.status === "failed"
    ? `<div class="fix-preparation fix-preparation-failed" data-fix-preparation-state="failed">Fix preparation failed — ${
      esc(row.fixPreparation.error ?? "unknown error")
    }</div>`
    : "";

  let body: string;
  let approveButton: string;
  let combinedButton = "";
  let pushButton = "";
  let acceptStatus = "";
  if (isMyPrRow(row)) {
    body = `
        ${renderIncomingFeedback(row)}
        ${renderReviewThreads(row)}`;
    const combined = combinedFixReplyAction(row);
    combinedButton = combined.button;
    pushButton = combined.pushButton;
    acceptStatus = combined.status;
    const hasUnposted = row.reviewThreads.some((t) => !t.posted);
    const hasSuggestedFix = row.unpreparedFixRootIds !== undefined
      ? row.unpreparedFixRootIds.length > 0
      : row.reviewThreads.some((t) => t.suggestedFix != null);
    approveButton = combinedButton
      ? ""
      : hasSuggestedFix
      ? `<button class="pbtn pbtn-tweak" onclick="firePrepareSelectedFixes(${row.prNumber}, this)">${
        hasUnposted
          ? "Prepare fixes &amp; queue selected replies"
          : "Prepare selected fixes"
      }</button>`
      : hasUnposted
      ? `<button class="pbtn pbtn-post-thread" onclick="firePostSelectedReplies(${row.prNumber}, this)">Post selected replies</button>`
      : "";
  } else {
    body =
      `<div class="needsyou-peer-hint">A drafted review is waiting — open the PR to read and send it.</div>`;
    approveButton =
      `<button class="pbtn pbtn-post" onclick="fireAction(${row.prNumber}, 'post-reply', 'Post reply', this)">Approve &amp; send</button>`;
  }

  const refineBox = isMyPrRow(row) ? renderRefineBox() : "";

  return `
      <article class="card card-needsyou needsyou-reply health-${
    esc(h)
  }" data-health="${esc(h)}" data-pr="${row.prNumber}">
        <header class="card-head">
          <div class="card-title">
            <span class="needsyou-kind-icon" aria-hidden="true">✉</span>
            <a class="card-link" href="${
    esc(prUrl)
  }" target="_blank" rel="noopener">${esc(row.title)}</a>
          </div>
          ${renderPrNumber(row)}
        </header>
        <div class="needsyou-label">Reply to send</div>
        ${summary}
        ${preparationFailure}
        ${body}
        <div class="card-footer">
          <div class="card-actions">
            ${combinedButton}
            ${approveButton}
            ${pushButton}
            <button class="pbtn pbtn-dismiss" onclick="dismissNeedsYouCard(${row.prNumber}, this)">Dismiss</button>
            <a class="link-action" href="${
    esc(prUrl)
  }" target="_blank" rel="noopener">Open PR ↗</a>
            ${renderTourControl(row)}
            ${renderIssueLinks(row.issueLinks)}
          </div>
          <div class="action-result" data-role="result" aria-live="polite"></div>
          ${acceptStatus}
        </div>
        ${refineBox}
      </article>`;
}

/**
 * Prepare a held, reviewable code diff from checked suggested-fix sketches.
 * This intentionally uses its own prepare-only workflow rather than the
 * independently-evolving pr-tweak workflow: preparation must never push.
 */
function renderRefineBox(): string {
  return `
        <details class="tweak-form needsyou-refine-form">
          <summary>▸ optional fix guidance</summary>
          <textarea class="tweak-textarea" data-role="tweak-instruction" rows="3"
            placeholder="Optional guidance for the selected fix sketches"></textarea>
        </details>
        <div class="action-result" data-role="tweak-status" aria-live="polite"></div>`;
}

/**
 * ⚠ Decision-needed card: reviewer comment / CI-fail context + the held
 * diff-stat + [Agree]/[Push back]/[Let me look]. Two sub-cases:
 *   - "glance" (an app-logic auto-fix diff is held awaiting a push) — shows
 *     the diff-stat + the EXISTING working one-click [Push]
 *     (`fireAcceptPush`, reusing `renderAcceptPushButton`'s transport).
 *   - "decision" (Phase 5, NEW): a `pr-triage-review` verdict landed
 *     "disagree" or "needs_question" — the reviewer's point needs a human
 *     CALL on how to respond, not just a rubber-stamp send. Shows the
 *     reviewer's comment (`renderIncomingFeedback`/`renderReviewThreads`,
 *     same accordions the ✉ card uses, so the full conversation + diff hunk +
 *     the agent's rationale/category are all one click away) plus THREE REAL
 *     buttons:
 *       - [Agree]      -> fireDecisionRedraft(..., 'agree')  — re-drafts an
 *         ACCEPTING brief; the verdict's category flips to "agree", so the
 *         NEXT scan promotes this card to ✉ Reply to send.
 *       - [Push back]  -> fireDecisionRedraft(..., 'disagree') — re-drafts a
 *         PUSH-BACK brief. The card stays labelled ⚠ (deriveNeedsYou only
 *         relabels "agree" verdicts to ✉), but the push-back brief is NOT
 *         stuck: this decision card embeds the same per-thread reply box +
 *         Approve & send that the ✉ card uses (via renderReviewThreads below),
 *         gated only on `posted`, never on `category`. So the reviewer expands the
 *         thread, reads the freshly-drafted push-back brief in the reply box,
 *         and sends it — same click, same postThreadReply path. The label
 *         staying ⚠ is cosmetic, not a dead end.
 *       - [Let me look] -> link-action only (opens the PR), no server call —
 *         the same "just go read it yourself" escape hatch every card has.
 * NEVER auto-posts: redraft only rewrites the verdict's suggestedReply/
 * category; the actual GitHub write still requires the owner's separate Approve &
 * send click on the ✉ card once the direction is settled.
 */
function renderDecisionCard(row: MyPrRow | PeerRow, repo: string): string {
  const h = healthOf(row);
  const prUrl = githubPrUrl(repo, row.prNumber);
  const summary = row.needsYou?.summary
    ? `<div class="needsyou-summary">${esc(row.needsYou.summary)}</div>`
    : "";

  const isGlance = row.needsYou?.kind === "glance";
  let diffBlock = "";
  let pushButton = "";
  if (isGlance && isMyPrRow(row)) {
    const kind = activeFixKind(row);
    const changedFiles = kind === "cifix"
      ? row.ciFixChangedFiles ?? 0
      : row.tweakChangedFiles ?? 0;
    const diffStat = kind === "cifix" ? row.ciFixDiffStat : row.tweakDiffStat;
    const diff = kind === "cifix" ? row.ciFixDiff : row.tweakDiff;
    diffBlock = diffStat || diff
      ? `<details class="tweak-diffstat"><summary>code diff (held, not yet pushed)</summary>${
        diffStat ? `<pre class="diff-stat">${esc(diffStat)}</pre>` : ""
      }${
        diff ? `<pre class="code-diff">${renderCodeDiff(diff)}</pre>` : ""
      }</details>`
      : "";
    pushButton = renderAcceptPushButton(row, kind, changedFiles);
  }

  // "decision" case: show the reviewer's comment + the agent's read (same
  // accordions the ✉ card uses) and the real Agree/Push-back buttons, keyed
  // to the freshest unposted verdict on this row.
  let decisionBody = "";
  let decisionButtons = "";
  if (!isGlance && isMyPrRow(row)) {
    const firstUnposted = row.reviewThreads.find((t) => !t.posted);
    decisionBody = `
        ${renderIncomingFeedback(row)}
        ${renderReviewThreads(row)}`;
    decisionButtons = firstUnposted
      ? `
            <button class="pbtn pbtn-post" onclick="fireDecisionRedraft(${row.prNumber}, '${
        escJs(firstUnposted.triageInstance)
      }', ${firstUnposted.rootId}, 'agree', this)">Agree</button>
            <button class="pbtn" onclick="fireDecisionRedraft(${row.prNumber}, '${
        escJs(firstUnposted.triageInstance)
      }', ${firstUnposted.rootId}, 'disagree', this)">Push back</button>`
      : "";
  }
  const letMeLookLink = `<a class="link-action pbtn-let-me-look" href="${
    esc(prUrl)
  }" target="_blank" rel="noopener">Let me look</a>`;
  const combined = isMyPrRow(row)
    ? combinedFixReplyAction(row)
    : { button: "", pushButton: "", status: "" };
  const glanceAcceptStatus = isGlance && isMyPrRow(row) && !combined.status
    ? renderAcceptStatus(
      row,
      activeFixKind(row),
    )
    : "";

  return `
      <article class="card card-needsyou needsyou-decision health-${
    esc(h)
  }" data-health="${esc(h)}" data-pr="${row.prNumber}">
        <header class="card-head">
          <div class="card-title">
            <span class="needsyou-kind-icon" aria-hidden="true">⚠</span>
            <a class="card-link" href="${
    esc(prUrl)
  }" target="_blank" rel="noopener">${esc(row.title)}</a>
          </div>
          ${renderPrNumber(row)}
        </header>
        <div class="needsyou-label">Decision needed</div>
        ${summary}
        ${diffBlock}
        ${decisionBody}
        <div class="card-footer">
          <div class="card-actions">
            ${combined.button}
            ${decisionButtons}
            ${letMeLookLink}
            ${pushButton || combined.pushButton}
            <button class="pbtn pbtn-dismiss" onclick="dismissNeedsYouCard(${row.prNumber}, this)">Dismiss</button>
            <a class="link-action" href="${
    esc(prUrl)
  }" target="_blank" rel="noopener">Open PR ↗</a>
            ${renderTourControl(row)}
            ${renderIssueLinks(row.issueLinks)}
          </div>
          <div class="action-result" data-role="result" aria-live="polite"></div>
          ${combined.status}
          ${glanceAcceptStatus}
        </div>
      </article>`;
}

/** Render one Needs-you row as whichever card shape its `needsYou.kind` calls for. */
function renderNeedsYouCard(row: MyPrRow | PeerRow, repo: string): string {
  return row.needsYou?.kind === "reply"
    ? renderReplyCard(row, repo)
    : renderDecisionCard(row, repo);
}

// ---------------------------------------------------------------------------
// Styles — dashboard design tokens
// ---------------------------------------------------------------------------

const STYLE = String.raw`
  /* Synthwave dark and GitHub-white light, shared with the PR tour page. */
  :root{color-scheme:dark;--bg:#241b2f;--panel:#2a2139;--card-start:#2a2139;--card-end:#251c31;--line:#3b2f55;--muted:#b2a8cc;--ink:#f8f4ff;--accent:#ff7edb;--cyan:#36f9f6;--amber:#fede5d;--red:#fe4450;--green:#72f1b8;--linear:#b9afff;--linear-border:#6e5ed7;--popover-shadow:0 18px 60px rgba(10,4,20,.6);
    --bg-image:radial-gradient(120% 70% at 50% -10%,rgb(114 54 168 / .45),transparent 60%);--neon:0 0 2px rgb(255 255 255 / .25),0 0 12px rgb(255 126 219 / .75);
    --font-ui:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--font-code:"JetBrains Mono",ui-monospace,"SF Mono",Menlo,monospace}
  :root[data-theme="light"]{color-scheme:light;--bg:#ffffff;--panel:#f6f8fa;--card-start:#ffffff;--card-end:#ffffff;--line:#d0d7de;--muted:#59636e;--ink:#1f2328;--accent:#0969da;--cyan:#0969da;--amber:#9a6700;--red:#cf222e;--green:#1a7f37;--linear:#5948b8;--linear-border:#8c7ce0;--popover-shadow:0 8px 24px rgba(140,149,159,.2);--bg-image:none;--neon:none}
  body{margin:0;background:var(--bg-image),var(--bg);background-attachment:fixed;color:var(--ink);font:14px/1.5 var(--font-ui)}
  code,pre,.pr-number,.scanned-at,.pill b,.review-thread-fix-files{font-family:var(--font-code)}
  *{box-sizing:border-box}
  /* No hard max-width cap — the grid should use the FULL viewport width on a
     wide monitor (the old 1240px, then 2200px, caps left a dead band on the
     right; see the "cards don't fill the screen" report). Padding keeps the
     content off the edges; the grid itself (below) governs column count. */
  .wrap{max-width:none;margin:0 auto;padding:2rem 2rem 4rem}


  header.page{position:relative;margin-bottom:1.6rem}
  header.page .kicker{font-size:.72rem;letter-spacing:.12em;text-transform:uppercase;color:var(--cyan);margin:0 0 .35rem}
  header.page h1{font-size:1.9rem;font-weight:800;margin:0 0 .5rem;letter-spacing:-0.01em;text-shadow:var(--neon)}
  .scanned-at{font-size:.82rem;color:var(--muted);margin:0 0 1rem}
  .poll-status{display:inline-flex;align-items:center;gap:.35rem}
  .poll-dot{display:inline-block;width:.5rem;height:.5rem;border-radius:50%;background:var(--muted)}
  .poll-status-connected .poll-dot{background:var(--green)}
  .poll-status-disconnected .poll-dot{background:var(--red)}
  .poll-status-pending .poll-dot{background:var(--amber)}

  .summary-strip{display:flex;gap:.6rem;flex-wrap:wrap;align-items:center;margin-bottom:.4rem}
  .pill{display:inline-flex;align-items:baseline;gap:.35rem;padding:.3rem .75rem;border-radius:999px;border:1px solid var(--line);background:var(--panel);font-size:.8rem;color:var(--muted)}
  .pill b{font-size:1rem;color:var(--ink)}
  .pill-red b{color:var(--red)}
  .pill-yellow b{color:var(--amber)}
  .pill-green b{color:var(--green)}
  .pill-total b{color:var(--cyan)}
  .pill-action b{color:var(--amber)}

  .pill-draft{background:var(--panel);border-color:var(--amber);color:var(--amber);font-weight:700;font-size:.66rem;letter-spacing:.05em;text-transform:uppercase;padding:.15rem .5rem}
  .pill-review{background:var(--panel);font-weight:700;font-size:.66rem;letter-spacing:.05em;text-transform:uppercase;padding:.15rem .5rem}
  .pill-review-approved{border-color:var(--green);color:var(--green)}
  .pill-review-changes-requested{border-color:var(--red);color:var(--red)}
  .pill-review-commented{border-color:var(--amber);color:var(--amber)}
  .pill-review-pending{color:var(--muted)}
  .pill-author{background:var(--panel);color:var(--ink);font-size:.72rem}
  .linear-links{display:flex;flex-wrap:wrap;gap:.4rem;margin-left:auto}
  .pill-linear{border-color:var(--linear-border);color:var(--linear);text-decoration:none;font-size:.72rem}
  .pill-linear:hover{filter:brightness(1.15)}
  .pill-reason-new{border-color:var(--cyan);color:var(--cyan);font-size:.72rem}
  .pill-reason-changed{border-color:var(--amber);color:var(--amber);font-size:.72rem}
  .pill-stack-pos{background:transparent;border-color:var(--line);color:var(--muted);font-size:.66rem;padding:.15rem .5rem}

  section.lane{margin-top:2.1rem}
  section.lane h2{font-size:1.15rem;font-weight:800;margin:0 0 .9rem;letter-spacing:-0.01em;display:flex;align-items:center;gap:.5rem}
  section.lane h2 .lane-count{font-size:.78rem;font-weight:600;color:var(--muted)}
  section.lane .lane-subtitle{font-size:.82rem;color:var(--muted);margin:-.6rem 0 .9rem}
  .agent-failure-center{position:absolute;right:0;top:0;z-index:5}
  .agent-failure-center summary{display:flex;align-items:center;justify-content:center;gap:.25rem;min-width:2.3rem;min-height:2.3rem;padding:.35rem .55rem;border:1px solid var(--line);border-radius:999px;background:var(--panel);cursor:pointer;list-style:none;font-size:1rem}
  .agent-failure-center summary::-webkit-details-marker{display:none}
  .agent-failure-center[open] summary{border-color:var(--red);color:var(--red)}
  .agent-failure-unread{min-width:1.15rem;padding:.05rem .3rem;border-radius:999px;background:var(--red);color:var(--bg);font-size:.65rem;font-weight:800;text-align:center}
  .agent-failure-unread[hidden]{display:none}
  .agent-failure-popover{position:absolute;right:0;top:2.8rem;width:min(760px,calc(100vw - 2rem));max-height:min(75vh,760px);overflow:auto;border:1px solid color-mix(in srgb,var(--red) 70%,var(--line));border-radius:12px;padding:1rem;background:var(--bg);box-shadow:var(--popover-shadow)}
  .agent-failure-toolbar{display:flex;align-items:center;justify-content:space-between;gap:.8rem;margin-bottom:.75rem}
  .agent-failure-toolbar strong{color:var(--red)}
  .agent-failure-mark{border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--muted);padding:.25rem .5rem;cursor:pointer;font:inherit;font-size:.7rem}
  .agent-failure-mark:hover{border-color:var(--cyan);color:var(--ink)}
  .agent-failure-status{color:var(--muted);font-size:.7rem}
  .agent-failures-all-read{display:none;color:var(--muted);font-size:.8rem;padding:.5rem 0}
  .agent-failure-list{display:grid;gap:.75rem}
  .agent-failure{border-left:4px solid var(--red);border-radius:8px;background:var(--panel);padding:.8rem 1rem}
  .agent-failure-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:.55rem;margin-bottom:.4rem}
  .agent-failure-phase{font-weight:800;color:var(--red)}
  .agent-failure-context,.agent-failure-meta{font-size:.76rem;color:var(--muted)}
  .agent-failure-reason{margin:.3rem 0;color:var(--ink);white-space:pre-wrap}
  .agent-failure-output,.agent-failure-gap{margin:.45rem 0 0;padding:.55rem .7rem;border-radius:6px;background:var(--bg);font-size:.76rem;white-space:pre-wrap;overflow-wrap:anywhere}
  .agent-failure-gap{border:1px solid var(--amber);color:var(--amber)}

  /* auto-FIT (not auto-fill): empty phantom tracks collapse, so the real cards
     stretch to fill the whole row instead of leaving a dead band on the right
     when there are few cards. minmax(320px, 1fr) means every card is ≥320px and
     they share the remaining width evenly — the grid packs as many ~320-460px
     columns as the full viewport fits (3 on a laptop, 5-6+ on a wide monitor),
     with no wasted horizontal space. */
  .card-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr));gap:1rem;align-items:start}
  .card-grid-compact{grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),560px));justify-content:start}

  /* A stack-group sits in the same grid cell as a standalone card, so a
     multi-PR stack and its neighboring singletons stay aligned in the flow. */
  .stack-group{grid-column:span 1;border:1px solid var(--line);border-radius:12px;padding:10px 10px 12px;background:color-mix(in srgb,var(--panel) 55%,transparent)}
  .stack-group.stack-health-red{border-color:var(--red)}
  .stack-group.stack-health-yellow{border-color:var(--amber)}
  /* The header row is grouping/expand-only in the calm redesign (the old
     stack-header-actions button row + apply-fixes note are gone). */
  .stack-header-block{display:flex;flex-direction:column;gap:.4rem;margin:.1rem .3rem .55rem}
  .stack-header{font-size:.72rem;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--cyan);display:flex;align-items:center;justify-content:space-between;gap:.6rem;cursor:pointer}
  .stack-header:hover{color:var(--ink)}
  .stack-header-label{display:flex;align-items:center;gap:.4rem}
  .stack-expand-hint{font-size:.68rem;color:var(--muted);text-transform:none;letter-spacing:0;font-weight:400}
  .stack-members{display:flex;flex-direction:column;gap:0;border-left:3px solid var(--cyan);padding-left:.7rem}
  .stack-group.stack-health-red .stack-members{border-left-color:var(--red)}
  .stack-group.stack-health-yellow .stack-members{border-left-color:var(--amber)}
  .stack-members .card{border-radius:8px;margin-bottom:.5rem}
  .stack-members .card:last-child{margin-bottom:0}
  /* Expanded (via toggleEntryExpand): the grid item spans every column so
     there's real width to read unfurled threads/diffs/comments, rather than
     squeezing them into a 1/3-viewport card. Only the CLICKED entry expands
     — everything else in the grid reflows around it. */
  .stack-group.expanded,.card-grid>.card.expanded{grid-column:1/-1}
  .stack-group.expanded .stack-members{border-left-width:4px}

  .card{background:linear-gradient(145deg,var(--card-start),var(--card-end));border:1px solid var(--line);border-radius:12px;padding:18px}
  .card.health-red{border-color:var(--red);box-shadow:0 0 0 1px color-mix(in srgb,var(--red) 35%,transparent) inset}
  .card.health-yellow{border-color:var(--amber)}
  .card.health-green{border-color:var(--line)}

  .card-head{display:flex;justify-content:space-between;align-items:flex-start;gap:.6rem;margin-bottom:.5rem}
  .card-title{display:flex;align-items:flex-start;gap:.5rem;min-width:0}
  .card-link{color:var(--ink);font-weight:700;text-decoration:none;font-size:.94rem;line-height:1.3}
  .card-link:hover{color:var(--cyan);text-decoration:underline}
  .pr-number{flex-shrink:0;font-size:.76rem;color:var(--accent);text-shadow:var(--neon);text-align:right}
  .pr-size{display:block;margin-top:.15rem;font-size:.7rem;text-shadow:none;white-space:nowrap}
  .pr-add{color:var(--green)}
  .pr-del{color:var(--red)}

  .dot{display:inline-block;width:.55rem;height:.55rem;border-radius:50%;margin-top:.3rem;flex-shrink:0}
  .dot.dot-red,.dot.bad{background:var(--red)}
  .dot.dot-amber{background:var(--amber)}
  .dot.dot-green,.dot.ok{background:var(--green)}
  .dot.dot-unknown{background:var(--muted)}

  .card-badges{display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:.55rem}
  .badge{font-size:.64rem;font-weight:800;text-transform:uppercase;letter-spacing:.05em;padding:.15rem .5rem;border-radius:5px;border:1px solid var(--line)}
  .badge-ci-red{background:color-mix(in srgb,var(--red) 18%,var(--panel));color:var(--red);border-color:var(--red)}
  .badge-ci-amber{background:color-mix(in srgb,var(--amber) 18%,var(--panel));color:var(--amber);border-color:var(--amber)}
  .badge-ci-green{background:color-mix(in srgb,var(--green) 18%,var(--panel));color:var(--green);border-color:var(--green)}
  .badge-ci-unknown{color:var(--muted)}

  .signal{white-space:nowrap}

  .card-activity{font-size:.72rem;color:var(--muted);margin-bottom:.5rem}

  /* Calm-redesign: a slim status row (My PRs / Peer PRs / Review pool) — no
     signals-row, no checks-list, no threads; just the badges above and a
     bare Open-PR link below. Slightly less internal padding than a dense
     card since there is so much less content to separate. */
  .card-slim{padding:14px 18px}
  .card-footer.card-footer-slim{margin-top:.5rem;padding-top:.5rem;border-top:1px solid var(--line);flex-direction:row;flex-wrap:wrap;align-items:center;justify-content:flex-start;gap:.5rem .6rem}

  /* The fading auto-fixed-CI trace (see renderAutoFixBadge's doc) — a quiet
     green one-liner, deliberately muted (not a loud badge) since it is
     backward-looking history, not something needing attention now. */
  .autofix-badge{margin-top:.4rem;font-size:.74rem;color:var(--green);opacity:.75}
  .autofix-when{color:var(--muted);font-size:.7rem}
  .fix-preparation{margin:.5rem 0;padding:.45rem .55rem;border-radius:7px;font-size:.76rem;font-weight:700}
  .fix-preparation-running{color:var(--cyan);border:1px solid var(--cyan);background:color-mix(in srgb,var(--cyan) 8%,var(--panel))}
  .fix-preparation-failed{color:var(--red);border:1px solid var(--red);background:color-mix(in srgb,var(--red) 8%,var(--panel))}

  /* Needs-you queue cards (✉ Reply-to-send / ⚠ Decision-needed) — same base
     .card shell as a calm row (border/background/radius), distinguished by
     a left accent rail per kind so the two shapes are visually distinct at a
     glance while scrolling the queue. */
  .card-needsyou{border-left:4px solid var(--cyan)}
  .card-needsyou.needsyou-decision{border-left-color:var(--amber)}
  .needsyou-kind-icon{font-size:1rem;line-height:1;flex-shrink:0}
  .needsyou-label{font-size:.72rem;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--cyan);margin-bottom:.5rem}
  .needsyou-decision .needsyou-label{color:var(--amber)}
  .needsyou-summary{font-size:.85rem;color:var(--ink);margin-bottom:.6rem}
  .needsyou-peer-hint{font-size:.85rem;color:var(--muted);margin-bottom:.6rem;font-style:italic}
  .needsyou-reply-textarea{width:100%;margin-top:.5rem;font:inherit;font-size:.85rem;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:7px;padding:.6rem;resize:vertical;box-sizing:border-box}
  /* The contextual refine box — collapsed by default, appears ONLY inside an
     open Needs-you card (see renderRefineBox's doc). No own divider — a
     plain block following .card-footer, same discipline as the rest of this
     file's "one shared border, not per-child dividers" rule. */
  .needsyou-refine-form{margin-top:.7rem}
  .needsyou-refine-form summary{cursor:pointer;color:var(--cyan);font-size:.76rem;font-weight:700}

  /* Divider now lives on the wrapping .card-footer (one border for the
     whole action region) — see the "cohesive action footer" note below. */
  .card-footer{margin-top:.6rem;padding-top:.6rem;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:.6rem}
  .card-actions{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap}
  .link-action{color:var(--cyan);font-size:.8rem;font-weight:700;text-decoration:none;white-space:nowrap}
  .link-action:hover{text-decoration:underline}

  .pbtn{font:inherit;font-size:.78rem;font-weight:700;padding:.3rem .7rem;border-radius:7px;border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer}
  .pbtn:not(:disabled):hover{filter:brightness(1.15);border-color:var(--cyan)}
  .pbtn:disabled{cursor:not-allowed;opacity:.45}
  .pbtn-post:not(:disabled){border-color:var(--amber);color:var(--amber)}
  .pbtn-dismiss:not(:disabled){border-color:var(--muted);color:var(--muted)}
  .tour-actions{display:inline-flex;gap:.5rem;align-items:center;white-space:nowrap}
  .tour-building{color:var(--muted);font-size:.8rem}
  .tour-stale{color:var(--muted)}

  .action-result{margin-top:.5rem;font-size:.78rem;min-height:1em}
  .action-result:empty{margin-top:0}
  .result-pending{color:var(--muted)}
  .result-success{color:var(--green);font-weight:700}
  .result-error{color:var(--red);font-weight:700}

  .badge-tweak-ok{color:var(--green);font-weight:700}
  .tweak-diffstat{margin-top:.3rem}
  .tweak-diffstat summary{cursor:pointer;color:var(--cyan);font-size:.74rem}
  .tweak-diffstat pre{margin:.3rem 0 0;font-size:.72rem;color:var(--muted);white-space:pre-wrap;word-break:break-word}
  .tweak-diffstat .code-diff{overflow-x:auto;background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:.5rem;white-space:pre}
  .diff-line{display:block;min-height:1em}
  .diff-add{color:var(--green);background:color-mix(in srgb,var(--green) 10%,transparent)}
  .diff-remove{color:var(--red);background:color-mix(in srgb,var(--red) 10%,transparent)}
  .diff-hunk{color:var(--cyan)}
  .diff-meta{color:var(--muted);font-weight:700}

  /* No own divider — a plain flex/block child of .card-footer (or, for the
     peer-review variant, of .card-actions) now that the footer draws ONE
     shared border-top instead of every sub-block drawing its own. */
  .tweak-form summary{cursor:pointer;color:var(--cyan);font-size:.78rem;font-weight:700}
  .tweak-textarea{width:100%;margin-top:.5rem;font:inherit;font-size:.8rem;background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:7px;padding:.5rem;resize:vertical;box-sizing:border-box}
  .tweak-form-actions{margin-top:.4rem;display:flex;justify-content:flex-end}
  .pbtn-tweak:not(:disabled){border-color:var(--cyan);color:var(--cyan)}
  /* "Reply only — no code fix" cue inside a drafted-reply thread that has no
     suggestedFix. */
  .review-thread-reply-only{margin-top:.5rem;font-size:.74rem;color:var(--muted);font-style:italic}
  .pbtn-accept:not(:disabled){border-color:var(--green);color:var(--green)}

  .review-threads-block{margin-top:.6rem;padding-top:.6rem;border-top:1px solid var(--line)}
  .review-threads-heading{font-size:.78rem;font-weight:700;color:var(--cyan);margin-bottom:.4rem}
  .addressed-hint{font-weight:400;color:var(--muted);font-size:.72rem}

  /* Hide-addressed filter. body.hide-addressed is the DEFAULT (set inline in
     <head> before first paint to avoid a flash of addressed content); the
     "Show addressed feedback" toggle removes it. .is-addressed marks both
     individual addressed items (posted replies, likely_addressed incoming
     threads) AND a whole block whose every item is addressed — so an all-clear
     PR's block disappears heading-and-all rather than showing an empty "(0)". */
  .view-controls{margin-top:.7rem;display:flex;justify-content:center;gap:1rem;flex-wrap:wrap}
  .toggle-addressed,.toggle-theme{display:inline-flex;align-items:center;gap:.4rem;cursor:pointer;font-size:.78rem;color:var(--muted)}
  .toggle-addressed input,.toggle-theme input{cursor:pointer}
  html:not([data-show-addressed]) body.hide-addressed .is-addressed{display:none}
  .review-thread{margin-top:.5rem;border:1px solid var(--line);border-radius:8px;background:var(--panel);overflow:hidden}
  .review-thread summary{cursor:pointer;list-style:none;padding:.55rem .6rem;display:flex;align-items:center;gap:.4rem;flex-wrap:wrap;font-size:.78rem}
  .review-thread summary::-webkit-details-marker{display:none}
  .review-thread summary code{font-size:.74rem;color:var(--muted)}
  .review-thread-summary-preview{color:var(--muted);font-size:.76rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1 1 auto}
  .review-thread-body{padding:0 .6rem .6rem;border-top:1px solid var(--line)}
  .review-thread-conversation{margin-top:.5rem;display:flex;flex-direction:column;gap:.5rem}
  .review-thread-comment{padding:.45rem .55rem;border-radius:7px;background:var(--bg);border:1px solid var(--line)}
  .review-thread-comment-meta{font-size:.72rem;color:var(--muted);display:flex;align-items:center;gap:.4rem}
  .review-thread-comment-body{margin-top:.3rem;font-size:.8rem;white-space:pre-wrap;word-break:break-word}
  .pill-author-bot{border-color:var(--amber);color:var(--amber)}
  .pill-author-human{border-color:var(--cyan);color:var(--cyan)}
  .incoming-feedback-block .review-threads-heading{color:var(--amber)}
  .pill-incoming-status-likely_unaddressed{border-color:var(--amber);color:var(--amber)}
  .pill-incoming-status-addressed_by_commit{border-color:var(--amber);color:var(--amber)}
  .pill-incoming-status-likely_addressed{border-color:var(--muted);color:var(--muted)}
  .review-thread-diff{margin-top:.5rem}
  .review-thread-diff summary{cursor:pointer;color:var(--cyan);font-size:.74rem;font-weight:700;padding:0;display:block}
  .review-thread-diff pre{margin-top:.35rem;font-size:.72rem;overflow-x:auto;background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:.5rem}
  .review-thread-fix{margin-top:.5rem;padding:.45rem .55rem;border-radius:7px;background:var(--bg);border:1px dashed var(--line)}
  .review-thread-fix-label{font-size:.72rem;color:var(--muted);font-weight:700}
  .review-thread-fix-files{margin-top:.25rem;font-size:.74rem;color:var(--muted)}
  .review-thread-fix-sketch{margin-top:.25rem;font-size:.8rem;white-space:pre-wrap}
  .review-thread-select{display:flex;align-items:center;gap:.4rem;margin:.45rem 0;color:var(--muted);font-size:.74rem;cursor:pointer}
  .review-thread-select input{accent-color:var(--cyan)}
  .review-thread-reply-row{margin-top:.5rem}
  .review-thread-reply-textarea{width:100%;font:inherit;font-size:.8rem;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:7px;padding:.5rem;resize:vertical;box-sizing:border-box}
  .review-thread-actions{margin-top:.4rem;display:flex;justify-content:flex-end}
  .pbtn-post-thread:not(:disabled){border-color:var(--green);color:var(--green)}
  .pill-confidence-high{border-color:var(--green);color:var(--green)}
  .pill-confidence-medium{border-color:var(--amber);color:var(--amber)}
  .pill-confidence-low{border-color:var(--muted);color:var(--muted)}

  .empty-state{text-align:center;color:var(--muted);padding:3rem 1rem;border:1px dashed var(--line);border-radius:12px}

  footer.page-footer{margin-top:2.5rem;padding-top:1rem;border-top:1px solid var(--line);color:var(--muted);font-size:.78rem;text-align:center}
`;

// The browser sends same-origin action requests. Only the server has the webhook secret.
const SCRIPT = String.raw`
  var HOOKS_PREFIX = '/actions';
  // Keeps an in-progress tweak/push message visible when the 30s board poll
  // replaces card markup. The server's persisted pushed/failed result wins
  // as soon as it appears on the refreshed card.
  var tweakStatusByPr = {};
  var acceptStatusByPrKind = {};

  function routeFor(kind) {
    return kind === 'peer-review' ? 'pr-peer-review'
      : kind === 'peer-dismiss' ? 'pr-peer-dismiss'
      : kind === 'post-reply' ? 'pr-post-reply'
      : kind === 'prepare-selected-fixes' ? 'pr-prepare-selected-fixes'
      : kind === 'accept-push' ? 'pr-accept-push'
      : kind === 'approve-push-reply' ? 'pr-approve-push-reply'
      : kind === 'post-selected-replies' ? 'pr-post-selected-replies'
      : kind === 'post-thread-reply' ? 'pr-post-thread-reply'
      : kind === 'decision-redraft' ? 'pr-decision-redraft'
      : kind === 'mark-agent-failures-read' ? 'pr-mark-agent-failures-read'
      : kind === 'tour' ? 'pr-tour'
      : 'pr-tweak';
  }

  // Concise, human failure message in place of a raw 501 HTML dump — see the
  // TS-side humanizeHookError doc comment for why. Kept in sync by hand (this
  // is the browser-side copy; humanizeHookError is the unit-tested pure twin).
  function humanizeHookError(status, text) {
    var trimmed = String(text || '').trim();
    if (trimmed.indexOf('<') === 0) {
      return 'Webhook unavailable (HTTP ' + status + ')';
    }
    return 'Failed (HTTP ' + status + '): ' + trimmed;
  }
  async function postHook(kind, body) {
    var headers = { 'Content-Type': 'application/json', 'X-Pr-Triage': '1' };
    var resp = await fetch(HOOKS_PREFIX + '/' + routeFor(kind), { method: 'POST', headers: headers, body: body });
    var text = await resp.text();
    return { ok: resp.ok, status: resp.status, text: text, resp: resp };
  }
  function cardFor(prNumber) {
    var cards = document.querySelectorAll('.card[data-pr]');
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].getAttribute('data-pr') === String(prNumber)) return cards[i];
    }
    return null;
  }

  function setResult(card, msg, kind) {
    var el = card ? card.querySelector('[data-role="result"]') : null;
    if (!el) return;
    el.textContent = msg;
    el.className = 'action-result' + (kind ? ' result-' + kind : '');
  }

  // "Dismiss" on a Needs-you card (✉/⚠) — a pure client-side "not now,"
  // NO server round-trip. Unlike the old peer-dismiss (which wrote a durable
  // peerDismiss marker so discover's own candidate filter kept the card gone
  // across scans), this just removes the card from view for THIS page load:
  // the underlying signal (unaddressed feedback / an unpushed fix) is still
  // true, so the next board scan re-derives the same needsYou and the card
  // reappears on the next poll. That is the intended behavior for Phase 1 —
  // a durable per-item dismiss-memory is a later-phase refinement, not a bug.
  function dismissNeedsYouCard(prNumber, btn) {
    var card = btn ? btn.closest('.card[data-pr="' + prNumber + '"]') : null;
    if (card && card.parentNode) { card.parentNode.removeChild(card); }
  }

  async function fireAction(prNumber, kind, actionLabel, btn) {
    var card = cardFor(prNumber);
    if (kind === 'post-reply') {
      var ok = window.confirm('Stage a pending GitHub review for PR #' + prNumber + '? (never auto-submitted)');
      if (!ok) return;
    }
    if (btn) { btn.disabled = true; }
    setResult(card, actionLabel + '…', 'pending');
    try {
      var body = JSON.stringify({ prNumber: prNumber });
      var result = await postHook(kind, body);
      if (!result.ok) {
        setResult(card, humanizeHookError(result.status, result.text), 'error');
        if (btn) { btn.disabled = false; }
        return;
      }
      var text = result.text;
      if (kind === 'peer-dismiss') {
        if (card && card.parentNode) { card.parentNode.removeChild(card); }
      } else {
        setResult(card, 'Pending review staged on GitHub. ' + text, 'success');
      }
    } catch (e) {
      setResult(card, 'Request error: ' + (e && e.message ? e.message : String(e)), 'error');
      if (btn) { btn.disabled = false; }
    }
  }

  // Fires the peer-review "Review this" form's optional focusArea textarea
  // alongside prNumber — read-only (drafts + writes review-<n>, never posts),
  // so unlike push/post actions this needs no confirm(). Shares the card's
  // [data-role="result"] status line with peer-dismiss/post-reply.
  async function firePeerReview(prNumber, btn) {
    var card = cardFor(prNumber);
    var textarea = card ? card.querySelector('[data-role="peer-focus"]') : null;
    var focusArea = textarea ? textarea.value.trim() : '';
    if (btn) { btn.disabled = true; }
    setResult(card, 'Review…', 'pending');
    try {
      var body = JSON.stringify({ prNumber: prNumber, focusArea: focusArea || undefined });
      var result = await postHook('peer-review', body);
      if (!result.ok) {
        setResult(card, humanizeHookError(result.status, result.text), 'error');
        if (btn) { btn.disabled = false; }
        return;
      }
      setResult(card, 'Drafted — refresh to see the review. ' + result.text, 'success');
    } catch (e) {
      setResult(card, 'Request error: ' + (e && e.message ? e.message : String(e)), 'error');
      if (btn) { btn.disabled = false; }
    }
  }

  function setTweakStatus(card, msg, kind) {
    var el = card ? card.querySelector('[data-role="tweak-status"]') : null;
    if (!el) return;
    el.textContent = msg;
    el.className = 'action-result' + (kind ? ' result-' + kind : '');
    var prNumber = card ? card.getAttribute('data-pr') : '';
    if (prNumber) { tweakStatusByPr[prNumber] = { msg: msg, kind: kind || '' }; }
  }

  // Tour requests the board has not caught up with yet. The webhook queues
  // the run, so the next poll can still show a plain Tour button; keep the
  // pending message until the card shows the server's own tour state, for
  // at most 6 minutes.
  var tourPendingByPr = {};
  var TOUR_PENDING_MESSAGE = 'Building tour… about 3 minutes. This card links to it when it is ready.';

  async function fireTour(prNumber, btn) {
    var card = cardFor(prNumber);
    if (btn) { btn.disabled = true; }
    setResult(card, 'Requesting tour…', 'pending');
    try {
      var result = await postHook('tour', JSON.stringify({ prNumber: prNumber }));
      if (!result.ok) {
        setResult(card, humanizeHookError(result.status, result.text), 'error');
        if (btn) { btn.disabled = false; }
        return;
      }
      tourPendingByPr[prNumber] = Date.now();
      setResult(card, TOUR_PENDING_MESSAGE, 'pending');
    } catch (e) {
      setResult(card, 'Request error: ' + (e && e.message ? e.message : String(e)), 'error');
      if (btn) { btn.disabled = false; }
    }
  }

  function restoreTourStatuses(root) {
    if (!root) return;
    var cards = root.querySelectorAll('.card[data-pr]');
    for (var i = 0; i < cards.length; i++) {
      var prNumber = cards[i].getAttribute('data-pr') || '';
      var since = tourPendingByPr[prNumber];
      if (!since) continue;
      var control = cards[i].querySelector('[data-tour-state]');
      var serverState = control ? control.getAttribute('data-tour-state') : 'none';
      if (Date.now() - since > 6 * 60 * 1000 || serverState === 'building' || serverState === 'ready') {
        delete tourPendingByPr[prNumber];
        continue;
      }
      var btn = control ? control.querySelector('button') : null;
      if (btn) { btn.disabled = true; }
      setResult(cards[i], TOUR_PENDING_MESSAGE, 'pending');
    }
  }

  function restoreTweakStatuses(root) {
    if (!root) return;
    var cards = root.querySelectorAll('.card[data-pr]');
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var prNumber = card.getAttribute('data-pr') || '';
      var persisted = card.querySelector('[data-tweak-push-state="pushed"], [data-tweak-push-state="failed"], [data-fix-preparation-state="failed"]');
      if (persisted) {
        delete tweakStatusByPr[prNumber];
        continue;
      }
      var status = tweakStatusByPr[prNumber];
      if (status) { setTweakStatus(card, status.msg, status.kind); }
    }
  }

  function restoreAcceptStatuses(root) {
    if (!root) return;
    var cards = root.querySelectorAll('.card[data-pr]');
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var prNumber = card.getAttribute('data-pr') || '';
      ['tweak', 'cifix'].forEach(function (kindKey) {
        var key = prNumber + ':' + kindKey;
        var persisted = card.querySelector('[data-role="accept-' + kindKey + '-status"][data-accept-push-state]');
        if (persisted) {
          delete acceptStatusByPrKind[key];
          return;
        }
        var status = acceptStatusByPrKind[key];
        if (status) { setAcceptStatus(card, kindKey, status.msg, status.kind); }
      });
    }
  }

  // Collect checked fix sketches scoped to this card. Fix selection is
  // independent from reply selection so either side can be exempted.
  function selectedFixRootIdsFor(card) {
    if (!card) return [];
    var boxes = card.querySelectorAll('[data-role^="fix-select-"]:checked');
    var ids = [];
    for (var i = 0; i < boxes.length; i++) {
      var m = /^fix-select-(\d+)$/.exec(boxes[i].getAttribute('data-role') || '');
      if (m) { ids.push(Number(m[1])); }
    }
    return ids;
  }

  function selectedFixTriageInstanceFor(card) {
    var box = card ? card.querySelector('[data-role^="fix-select-"]:checked') : null;
    return box ? box.getAttribute('data-triage-instance') || '' : '';
  }

  async function firePrepareSelectedFixes(prNumber, btn) {
    var card = cardFor(prNumber);
    var textarea = card ? card.querySelector('[data-role="tweak-instruction"]') : null;
    var instruction = textarea ? textarea.value.trim() : '';
    var selectedRootIds = selectedFixRootIdsFor(card);
    var triageInstance = selectedFixTriageInstanceFor(card);
    if (selectedRootIds.length === 0 || !triageInstance) {
      setTweakStatus(card, 'Check at least one suggested fix first.', 'error');
      return;
    }
    if (btn) { btn.disabled = true; }
    setTweakStatus(card, 'Preparing a held diff in an isolated worktree…', 'pending');
    try {
      var body = JSON.stringify({
        prNumber: prNumber,
        instruction: instruction,
        triageInstance: triageInstance || undefined,
        selectedRootIds: selectedRootIds
      });
      var result = await postHook('prepare-selected-fixes', body);
      if (!result.ok) {
        setTweakStatus(card, humanizeHookError(result.status, result.text), 'error');
        if (btn) { btn.disabled = false; }
        return;
      }
      setTweakStatus(card, 'Fix preparation running — nothing will push. Refresh shortly to review the held diff.', 'success');
    } catch (e) {
      setTweakStatus(card, 'Request error: ' + (e && e.message ? e.message : String(e)), 'error');
      if (btn) { btn.disabled = false; }
    }
  }

  function setAcceptStatus(card, kindKey, msg, resultKind) {
    var el = card ? card.querySelector('[data-role="accept-' + kindKey + '-status"]') : null;
    if (!el) return;
    el.textContent = msg;
    el.className = 'action-result' + (resultKind ? ' result-' + resultKind : '');
    var prNumber = card ? card.getAttribute('data-pr') : '';
    if (prNumber) { acceptStatusByPrKind[prNumber + ':' + kindKey] = { msg: msg, kind: resultKind || '' }; }
  }

  // "Accept & push" (shown on a tweak/cifix badge once that run has a
  // cifix result shows independent outcomes.
  async function fireAcceptPush(prNumber, kindKey, btn) {
    var card = cardFor(prNumber);
    var ok = window.confirm(
      'Verify and push the reviewed ' + kindKey + ' result for PR #' + prNumber +
      '?\n\nThe configured workflow must verify the exact reviewed candidate before pushing.'
    );
    if (!ok) return;
    if (btn) { btn.disabled = true; }
    setAcceptStatus(card, kindKey, 'Verifying…', 'pending');
    try {
      var body = JSON.stringify({ prNumber: prNumber, kind: kindKey });
      var result = await postHook('accept-push', body);
      if (!result.ok) {
        setAcceptStatus(card, kindKey, humanizeHookError(result.status, result.text), 'error');
        if (btn) { btn.disabled = false; }
        return;
      }
      setAcceptStatus(card, kindKey, 'Verification + push running — refresh in a bit to see the outcome.', 'success');
    } catch (e) {
      setAcceptStatus(card, kindKey, 'Request error: ' + (e && e.message ? e.message : String(e)), 'error');
      if (btn) { btn.disabled = false; }
    }
  }

  function selectedRepliesFor(card) {
    if (!card) return [];
    var boxes = card.querySelectorAll('[data-role^="reply-select-"]:checked');
    var replies = [];
    for (var i = 0; i < boxes.length; i++) {
      var role = boxes[i].getAttribute('data-role') || '';
      var match = /^reply-select-(\d+)$/.exec(role);
      if (!match) continue;
      var rootId = Number(match[1]);
      var textarea = card.querySelector('[data-role="reply-text-' + rootId + '"]');
      replies.push({
        triageInstance: boxes[i].getAttribute('data-triage-instance') || '',
        rootId: rootId,
        replyBody: textarea ? textarea.value.trim() : ''
      });
    }
    return replies;
  }

  async function firePostSelectedReplies(prNumber, btn) {
    var card = cardFor(prNumber);
    var replies = selectedRepliesFor(card);
    if (replies.length === 0) {
      setResult(card, 'Select at least one reply to post.', 'error');
      return;
    }
    for (var i = 0; i < replies.length; i++) {
      if (!replies[i].triageInstance || !replies[i].replyBody) {
        setPostThreadReplyStatus(card, replies[i].rootId, 'Selected reply text is empty.', 'error');
        return;
      }
    }
    var preview = replies.map(function(reply) { return '• ' + reply.replyBody; }).join('\n\n');
    var ok = window.confirm(
      'Post ' + replies.length + ' selected repl' + (replies.length === 1 ? 'y' : 'ies') + ' to GitHub now?\n\n' + preview
    );
    if (!ok) return;
    if (btn) { btn.disabled = true; }
    setResult(card, 'Posting selected replies…', 'pending');
    for (var j = 0; j < replies.length; j++) {
      setPostThreadReplyStatus(card, replies[j].rootId, 'Queued for posting…', 'pending');
    }
    try {
      var body = JSON.stringify({ replies: replies });
      var result = await postHook('post-selected-replies', body);
      if (!result.ok) {
        setResult(card, humanizeHookError(result.status, result.text), 'error');
        if (btn) { btn.disabled = false; }
        return;
      }
      setResult(card, 'Selected replies are posting — refresh shortly for the outcome.', 'success');
    } catch (e) {
      setResult(card, 'Request error: ' + (e && e.message ? e.message : String(e)), 'error');
      if (btn) { btn.disabled = false; }
    }
  }

  async function fireApprovePushAndReply(prNumber, kindKey, btn) {
    var card = cardFor(prNumber);
    var replies = selectedRepliesFor(card);
    if (replies.length === 0) {
      setAcceptStatus(card, kindKey, 'Select at least one reply to post.', 'error');
      return;
    }
    for (var i = 0; i < replies.length; i++) {
      if (!replies[i].triageInstance || !replies[i].replyBody) {
        setPostThreadReplyStatus(card, replies[i].rootId, 'Selected reply text is empty.', 'error');
        return;
      }
    }
    var replyPreview = replies.map(function(reply) {
      return '• ' + reply.replyBody;
    }).join('\n\n');
    var ok = window.confirm(
      'Push the reviewed ' + kindKey + ' fix to PR #' + prNumber + ' AND post ' + replies.length + ' selected repl' + (replies.length === 1 ? 'y' : 'ies') + '?\n\n' +
      replyPreview
    );
    if (!ok) return;
    if (btn) { btn.disabled = true; }
    setAcceptStatus(card, kindKey, 'Verifying and pushing first…', 'pending');
    for (var j = 0; j < replies.length; j++) {
      setPostThreadReplyStatus(card, replies[j].rootId, 'Waiting for the push before posting…', 'pending');
    }
    try {
      var body = JSON.stringify({
        prNumber: prNumber,
        kind: kindKey,
        replies: replies
      });
      var result = await postHook('approve-push-reply', body);
      if (!result.ok) {
        var message = humanizeHookError(result.status, result.text);
        setAcceptStatus(card, kindKey, message, 'error');
        for (var l = 0; l < replies.length; l++) {
          setPostThreadReplyStatus(card, replies[l].rootId, message, 'error');
        }
        if (btn) { btn.disabled = false; }
        return;
      }
      setAcceptStatus(card, kindKey, 'Combined action running — the reply is gated on a successful push.', 'success');
      for (var m = 0; m < replies.length; m++) {
        setPostThreadReplyStatus(card, replies[m].rootId, 'Push + selected replies running — refresh shortly for the outcome.', 'success');
      }
    } catch (e) {
      var message = 'Request error: ' + (e && e.message ? e.message : String(e));
      setAcceptStatus(card, kindKey, message, 'error');
      for (var n = 0; n < replies.length; n++) {
        setPostThreadReplyStatus(card, replies[n].rootId, message, 'error');
      }
      if (btn) { btn.disabled = false; }
    }
  }

  function setPostThreadReplyStatus(card, rootId, msg, kind) {
    var el = card ? card.querySelector('[data-role="post-reply-status-' + rootId + '"]') : null;
    if (!el) return;
    el.textContent = msg;
    el.className = 'action-result' + (kind ? ' result-' + kind : '');
  }

  // "Post reply" (per drafted thread) POSTs {triageInstance, rootId} to
  // /pr-hooks/pr-post-thread-reply. THREADED, immediate — posts under the
  // original comment the moment you confirm, unlike peer-review's
  // postReview (a pending review needing a separate GitHub-side submit).
  // postThreadReply itself refuses a double-post, but the button also
  // disappears once posted (see renderReviewThreads) so a stale page can't
  // invite a doomed retry.
  async function firePostThreadReply(triageInstance, rootId, prNumber, btn) {
    var card = cardFor(prNumber);
    var textarea = card ? card.querySelector('[data-role="reply-text-' + rootId + '"]') : null;
    var replyText = textarea ? textarea.value.trim() : '';
    if (!replyText) {
      setPostThreadReplyStatus(card, rootId, 'Reply text is empty.', 'error');
      return;
    }
    var ok = window.confirm('Post this reply to GitHub now? This is immediate and visible to reviewers.\n\n' + replyText);
    if (!ok) return;
    if (btn) { btn.disabled = true; }
    setPostThreadReplyStatus(card, rootId, 'Posting…', 'pending');
    try {
      // Always send the CURRENT textarea contents as replyBody — whether or
      // not it was edited, this is what actually gets posted. postReply
      // treats replyBody as an override of suggestedReply; sending it
      // unconditionally (rather than only when changed) keeps the contract
      // simple: "post exactly what's on screen."
      var body = JSON.stringify({ triageInstance: triageInstance, rootId: rootId, replyBody: replyText });
      var result = await postHook('post-thread-reply', body);
      if (!result.ok) {
        setPostThreadReplyStatus(card, rootId, humanizeHookError(result.status, result.text), 'error');
        if (btn) { btn.disabled = false; }
        return;
      }
      setPostThreadReplyStatus(card, rootId, 'Posted — refresh to see it marked posted.', 'success');
    } catch (e) {
      setPostThreadReplyStatus(card, rootId, 'Request error: ' + (e && e.message ? e.message : String(e)), 'error');
      if (btn) { btn.disabled = false; }
    }
  }

  // "Agree"/"Push back" on a ⚠ Decision-needed card POSTs {prNumber,
  // triageInstance, rootId, direction} to /pr-hooks/pr-decision-redraft. This
  // NEVER posts to GitHub — it only re-drafts the verdict's suggestedReply/
  // category in the chosen direction (pr-triage-review.redraftInDirection).
  // On success the card's own status line reports the re-draft; the NEXT
  // 30s board poll picks up the flipped category and, if it's now "agree",
  // promotes the card from ⚠ decision to ✉ reply where the reviewer approves & sends
  // it for real. Reuses the shared card [data-role="result"] status line —
  // decision cards don't have a per-thread status element the way the ✉
  // card's per-thread reply rows do, since a decision card renders exactly
  // one (the freshest unposted) verdict's Agree/Push-back pair.
  async function fireDecisionRedraft(prNumber, triageInstance, rootId, direction, btn) {
    var card = cardFor(prNumber);
    if (btn) { btn.disabled = true; }
    setResult(card, (direction === 'agree' ? 'Drafting an accepting reply…' : 'Drafting a push-back reply…'), 'pending');
    try {
      var body = JSON.stringify({ prNumber: prNumber, triageInstance: triageInstance, rootId: rootId, direction: direction });
      var result = await postHook('decision-redraft', body);
      if (!result.ok) {
        setResult(card, humanizeHookError(result.status, result.text), 'error');
        if (btn) { btn.disabled = false; }
        return;
      }
      setResult(card, 'Re-drafted — refresh to see the updated brief' + (direction === 'agree' ? ' (moves to Reply to send).' : '.'), 'success');
    } catch (e) {
      setResult(card, 'Request error: ' + (e && e.message ? e.message : String(e)), 'error');
      if (btn) { btn.disabled = false; }
    }
  }

  // Accordion: opening one thread's <details> closes every OTHER open
  // thread on the SAME card, so at most one thread's full context (comment
  // conversation, diff hunk, editable reply) is on screen at a time — a PR
  // can have 7+ threads, and this keeps the page a manageable scroll on
  // mobile. Scoped to the card (not the whole page) so different PRs'
  // accordions stay independent.
  function toggleThreadAccordion(el) {
    // While the card/stack is expanded (see toggleEntryExpand), every
    // thread is meant to stay open at once — that IS the "unfurled" reading
    // view this expand mode exists for. Skip the one-at-a-time collapse so
    // opening/closing one thread doesn't fight the expanded state.
    if (el.closest('.expanded')) return;
    if (!el.open) return;
    var card = el.closest('.card');
    if (!card) return;
    var siblings = card.querySelectorAll('.review-thread[open]');
    for (var i = 0; i < siblings.length; i++) {
      if (siblings[i] !== el) { siblings[i].open = false; }
    }
  }

  // Click-to-expand for a standalone My-PR card's header, or a stack's
  // header (toggleEntryExpand(this) / toggleEntryExpand(this.closest(...))
  // respectively — see renderMyPrCard/renderStackGroup). Expanding spans the
  // clicked entry across the full grid width (see .expanded CSS) so there's
  // real room to read unfurled threads, diffs, and comments instead of
  // squeezing them into a 1-of-3 grid column. Collapsing shrinks it back but
  // deliberately leaves any threads the user opened alone (they may still
  // want to read them) rather than force-closing everything.
  function toggleEntryExpand(el) {
    if (!el) return;
    var entry = el.classList.contains('card') || el.classList.contains('stack-group')
      ? el
      : el.closest('.card, .stack-group');
    if (!entry) return;
    var expanding = !entry.classList.contains('expanded');
    entry.classList.toggle('expanded', expanding);
    if (expanding) {
      var threads = entry.querySelectorAll('.review-thread');
      for (var i = 0; i < threads.length; i++) { threads[i].open = true; }
    }
  }

  // Hide-addressed toggle. The server renders <body class="hide-addressed"> as
  // the default and the <head> pre-paint script may have stamped
  // documentElement.dataset.showAddressed from sessionStorage; here we reconcile
  // <body> + the checkbox to that saved preference on load, and wire the toggle
  // to flip both the class and the persisted preference. sessionStorage (not
  // local) so the choice survives a poll-driven DOM swap but resets in a
  // fresh tab — the safe default is always "hide clutter."
  function applyShowAddressed(show) {
    document.body.classList.toggle('hide-addressed', !show);
    // Mirror onto <html> so the CSS flag the <head> pre-paint set stays in sync
    // with a runtime toggle — the hide rule keys off html:not([data-show-
    // addressed]) AND body.hide-addressed, so both the body class and the
    // absence of this flag must agree for addressed items to hide.
    if (show) { document.documentElement.dataset.showAddressed = '1'; }
    else { delete document.documentElement.dataset.showAddressed; }
    try {
      if (show) { sessionStorage.setItem('pr-triage:show-addressed', '1'); }
      else { sessionStorage.removeItem('pr-triage:show-addressed'); }
    } catch (_e) { /* sessionStorage unavailable — in-memory toggle still works */ }
  }
  (function initShowAddressed() {
    var saved = false;
    try { saved = sessionStorage.getItem('pr-triage:show-addressed') === '1'; } catch (_e) {}
    var toggle = document.getElementById('show-addressed-toggle');
    if (toggle) {
      toggle.checked = saved;
      toggle.addEventListener('change', function () { applyShowAddressed(toggle.checked); });
    }
    applyShowAddressed(saved);
  })();

  // Theme toggle. Persist across tabs and restore in the <head> before paint,
  // avoiding a dark flash when light mode is selected.
  function applyTheme(light) {
    if (light) { document.documentElement.dataset.theme = 'light'; }
    else { delete document.documentElement.dataset.theme; }
    try {
      if (light) { localStorage.setItem('pr-triage:theme', 'light'); }
      else { localStorage.removeItem('pr-triage:theme'); }
    } catch (_e) { /* localStorage unavailable — in-memory toggle still works */ }
  }
  (function initTheme() {
    var light = false;
    try { light = localStorage.getItem('pr-triage:theme') === 'light'; } catch (_e) {}
    var toggle = document.getElementById('light-mode-toggle');
    if (toggle) {
      toggle.checked = light;
      toggle.addEventListener('change', function () { applyTheme(toggle.checked); });
    }
    applyTheme(light);
  })();

  // ── Live poll ──────────────────────────────────────────────────────────────
  // Replaces the old 60s meta-refresh: a full-page reload wipes out any reply
  // text a user has typed into a textarea but not yet posted. Instead, poll
  // GET /board every 30s and patch just the two lane bodies —
  // preserving in-flight edits (open accordions, unposted textarea drafts,
  // scroll position) and NEVER swapping a lane the user is actively typing in.
  //
  // editStateKey/prNumberFor are trivial pure helpers that run in-browser only
  // (there are no TS twins — the keying is a plain string concat, and the
  // report tests assert the helpers are PRESENT in the emitted SCRIPT rather
  // than exercising them, since this Deno test runtime has no DOM).
  function editStateKey(prNumber, role) {
    return 'pr:' + prNumber + '|role:' + role;
  }

  function replyDraftStorageKey(prNumber, role) {
    return 'pr-triage:reply-draft|' + editStateKey(prNumber, role);
  }

  // Persist an edited reply in this browser so a refresh — or a card leaving
  // and later returning to Needs you — does not throw the edit away. Keep the
  // server-rendered draft as a baseline: if triage later produces a genuinely
  // new draft, the stale browser edit must not silently overwrite it.
  function persistReplyDraft(textarea) {
    var role = textarea && textarea.getAttribute('data-role');
    var prNumber = textarea ? prNumberFor(textarea) : null;
    if (prNumber == null || !role || role.indexOf('reply-text-') !== 0) return;
    var key = replyDraftStorageKey(prNumber, role);
    try {
      if (textarea.value === textarea.defaultValue) {
        window.localStorage.removeItem(key);
        return;
      }
      window.localStorage.setItem(key, JSON.stringify({
        value: textarea.value,
        baseline: textarea.defaultValue
      }));
    } catch (_) {
      // Private browsing/storage policy can disable localStorage. The existing
      // in-memory poll preservation still works, so storage failure is benign.
    }
  }

  function restorePersistedReplyDrafts(root) {
    if (!root) return;
    var textareas = root.querySelectorAll('textarea[data-role^="reply-text-"]');
    for (var i = 0; i < textareas.length; i++) {
      var textarea = textareas[i];
      var role = textarea.getAttribute('data-role');
      var prNumber = prNumberFor(textarea);
      if (prNumber == null || !role) continue;
      var key = replyDraftStorageKey(prNumber, role);
      try {
        var raw = window.localStorage.getItem(key);
        if (!raw) continue;
        var saved = JSON.parse(raw);
        if (!saved || typeof saved.value !== 'string' || saved.baseline !== textarea.defaultValue) {
          window.localStorage.removeItem(key);
          continue;
        }
        textarea.value = saved.value;
      } catch (_) {
        try { window.localStorage.removeItem(key); } catch (_) { /* unavailable */ }
      }
    }
  }

  // The nearest ancestor card's PR number for an element inside a lane, or
  // null if it isn't inside a [data-pr] card (shouldn't happen for the
  // textareas/details this is used on, but never throw over a stale DOM).
  function prNumberFor(el) {
    var card = el.closest ? el.closest('.card[data-pr]') : null;
    if (!card) return null;
    var n = Number(card.getAttribute('data-pr'));
    return Number.isFinite(n) ? n : null;
  }

  // Snapshot every textarea value (keyed pr:<n>|role:<data-role>), every open
  // <details data-root-id> (keyed the same way), and scrollY — for the ONE
  // lane subtree being swapped. Pure: takes the lane root, returns a plain
  // object; never mutates the DOM.
  function captureEditState(root) {
    var textareas = {};
    if (root) {
      var tas = root.querySelectorAll('textarea[data-role]');
      for (var i = 0; i < tas.length; i++) {
        var ta = tas[i];
        var role = ta.getAttribute('data-role');
        var prNumber = prNumberFor(ta);
        if (prNumber == null || !role) continue;
        textareas[editStateKey(prNumber, role)] = ta.value;
      }
    }
    var selections = {};
    if (root) {
      var boxes = root.querySelectorAll('input[type="checkbox"][data-role]');
      for (var b = 0; b < boxes.length; b++) {
        var box = boxes[b];
        var boxRole = box.getAttribute('data-role');
        var boxPrNumber = prNumberFor(box);
        if (boxPrNumber == null || !boxRole) continue;
        selections[editStateKey(boxPrNumber, boxRole)] = box.checked;
      }
    }
    var openAccordions = {};
    if (root) {
      var openDetails = root.querySelectorAll('details[open][data-root-id]');
      for (var j = 0; j < openDetails.length; j++) {
        var d = openDetails[j];
        var prNumber2 = prNumberFor(d);
        var rootId = d.getAttribute('data-root-id');
        if (prNumber2 == null || !rootId) continue;
        openAccordions[editStateKey(prNumber2, 'accordion-' + rootId)] = true;
      }
    }
    return { textareas: textareas, selections: selections, openAccordions: openAccordions, scrollY: window.scrollY };
  }

  // After an innerHTML swap of 'root', write back every captured textarea
  // value whose element still exists in the fresh DOM — the captured value IS
  // what the user sees/wants, so it always wins EXCEPT when the textarea is
  // now empty in the snapshot AND the fresh server default is non-empty: that
  // combination means a draft got posted/regenerated server-side, so the new
  // server value should win instead of clobbering it back to blank. Re-opens
  // the accordions that were open, then restores scrollY.
  function restoreEditState(root, snapshot) {
    if (!root || !snapshot) return;
    var tas = root.querySelectorAll('textarea[data-role]');
    for (var i = 0; i < tas.length; i++) {
      var ta = tas[i];
      var role = ta.getAttribute('data-role');
      var prNumber = prNumberFor(ta);
      if (prNumber == null || !role) continue;
      var key = editStateKey(prNumber, role);
      if (!Object.prototype.hasOwnProperty.call(snapshot.textareas, key)) continue;
      var savedValue = snapshot.textareas[key];
      if (savedValue === '' && ta.value !== '') continue;
      ta.value = savedValue;
    }
    var boxes = root.querySelectorAll('input[type="checkbox"][data-role]');
    for (var b = 0; b < boxes.length; b++) {
      var box = boxes[b];
      var boxRole = box.getAttribute('data-role');
      var boxPrNumber = prNumberFor(box);
      if (boxPrNumber == null || !boxRole) continue;
      var boxKey = editStateKey(boxPrNumber, boxRole);
      if (snapshot.selections && Object.prototype.hasOwnProperty.call(snapshot.selections, boxKey)) {
        box.checked = snapshot.selections[boxKey];
      }
    }
    var openDetails = root.querySelectorAll('details[data-root-id]');
    for (var j = 0; j < openDetails.length; j++) {
      var d = openDetails[j];
      var prNumber2 = prNumberFor(d);
      var rootId = d.getAttribute('data-root-id');
      if (prNumber2 == null || !rootId) continue;
      var accKey = editStateKey(prNumber2, 'accordion-' + rootId);
      if (snapshot.openAccordions[accKey]) { d.open = true; }
    }
    window.scrollTo(0, snapshot.scrollY);
  }

  // True when the document's currently-focused element sits inside 'root' and
  // is a textarea — i.e. the user is actively typing in this lane right now.
  // Swapping innerHTML under an active cursor is hostile (it yanks the DOM out
  // from under the keystroke), so this is checked BEFORE every swap and, when
  // true, the whole lane is skipped for this poll cycle (tried again next
  // cycle, 30s later).
  function laneHasActiveEdit(root) {
    if (!root) return false;
    var active = document.activeElement;
    if (!active || active.tagName !== 'TEXTAREA') return false;
    return root.contains(active);
  }

  // Swap one lane's innerHTML to 'html', preserving in-flight edits — unless
  // the user is actively typing inside this lane right now, in which case the
  // swap is skipped entirely for this cycle (see laneHasActiveEdit).
  function swapLane(root, html) {
    if (!root) return;
    if (laneHasActiveEdit(root)) return;
    var snapshot = captureEditState(root);
    root.innerHTML = html;
    restorePersistedReplyDrafts(root);
    restoreEditState(root, snapshot);
    restoreTweakStatuses(root);
    restoreAcceptStatuses(root);
    restoreTourStatuses(root);
  }

  function applyAgentFailureReadState() {
    var root = document.getElementById('agent-failures-body');
    var badge = document.getElementById('agentfailures-lane-count');
    var empty = document.getElementById('agent-failures-all-read');
    if (!root) return;
    var unread = 0;
    root.querySelectorAll('[data-invocation-id]').forEach(function (failure) {
      if (!failure.hidden) unread += 1;
    });
    if (badge) {
      badge.textContent = String(unread);
      badge.hidden = unread === 0;
    }
    if (empty) empty.style.display = unread === 0 ? 'block' : 'none';
  }

  function setAgentFailureStatus(message, kind) {
    var status = document.getElementById('agent-failure-status');
    if (!status) return;
    status.textContent = message;
    status.className = 'agent-failure-status' + (kind ? ' result-' + kind : '');
  }

  async function markAgentFailuresRead(invocationIds) {
    if (!invocationIds.length) return;
    setAgentFailureStatus('Saving…', 'pending');
    try {
      // The hook accepts at most 200 IDs per call; a long outage can exceed that.
      for (var start = 0; start < invocationIds.length; start += 200) {
        var result = await postHook('mark-agent-failures-read', JSON.stringify({ invocationIds: invocationIds.slice(start, start + 200) }));
        if (!result.ok) {
          setAgentFailureStatus(humanizeHookError(result.status, result.text), 'error');
          return;
        }
      }
      var acknowledged = new Set(invocationIds);
      document.querySelectorAll('#agent-failures-body [data-invocation-id]').forEach(function (failure) {
        if (failureIds(failure).every(function (id) { return acknowledged.has(id); })) failure.hidden = true;
      });
      applyAgentFailureReadState();
      setAgentFailureStatus('Saved for every device.', 'success');
    } catch (e) {
      setAgentFailureStatus('Request error: ' + (e && e.message ? e.message : String(e)), 'error');
    }
  }

  // A collapsed entry carries every invocation it stands for.
  function failureIds(failure) {
    var ids = (failure.dataset.invocationIds || '').split(' ').filter(Boolean);
    return ids.length ? ids : [failure.dataset.invocationId || ''].filter(Boolean);
  }

  function markAllAgentFailuresRead() {
    var ids = [];
    document.querySelectorAll('#agent-failures-body [data-invocation-id]:not([hidden])').forEach(function (failure) {
      ids = ids.concat(failureIds(failure));
    });
    return markAgentFailuresRead(ids);
  }

  // Apply one /board response: swap the My-PR, Needs-you,
  // Peer-PR, and Review-pool lane bodies independently (each with its own
  // active-edit guard), so typing in one lane never blocks the others from
  // refreshing. Existing action buttons (firePrepareSelectedFixes, firePostThreadReply,
  // fireAcceptPush, etc.) are wired via inline onclick= attributes baked into
  // the fresh HTML, so they work immediately post-swap with no re-binding
  // needed.
  function applyBoardUpdate(data) {
    var agentFailureRoot = document.getElementById('agent-failures-body');
    var myRoot = document.getElementById('my-lane-body');
    var needsYouRoot = document.getElementById('needsyou-lane-body');
    var peerRoot = document.getElementById('peer-lane-body');
    var reviewPoolRoot = document.getElementById('reviewpool-lane-body');
    if (agentFailureRoot && typeof data.agentFailuresHtml === 'string') { swapLane(agentFailureRoot, data.agentFailuresHtml); }
    if (myRoot && typeof data.myLaneHtml === 'string') { swapLane(myRoot, data.myLaneHtml); }
    if (needsYouRoot && typeof data.needsYouHtml === 'string') { swapLane(needsYouRoot, data.needsYouHtml); }
    if (peerRoot && typeof data.peerLaneHtml === 'string') { swapLane(peerRoot, data.peerLaneHtml); }
    if (reviewPoolRoot && typeof data.reviewPoolHtml === 'string') { swapLane(reviewPoolRoot, data.reviewPoolHtml); }
    var counts = data.laneCounts || {};
    ['my', 'needsyou', 'peer', 'reviewpool'].forEach(function (lane) {
      var count = document.getElementById(lane + '-lane-count');
      if (count && typeof counts[lane] === 'number') { count.textContent = String(counts[lane]); }
    });
    applyAgentFailureReadState();
  }

  function setPollStatus(connected, text) {
    var el = document.getElementById('poll-status');
    var textEl = document.getElementById('poll-status-text');
    if (textEl) { textEl.textContent = text; }
    if (el) {
      el.className = 'poll-status ' + (connected ? 'poll-status-connected' : 'poll-status-disconnected');
    }
  }

  async function poll() {
    try {
      var resp = await fetch('/board', { cache: 'no-store' });
      if (!resp.ok) { throw new Error('HTTP ' + resp.status); }
      var data = await resp.json();
      if (!data || data.ok !== true) { throw new Error('board endpoint returned ok:false'); }
      applyBoardUpdate(data);
      var when = new Date(data.scannedAt || Date.now());
      setPollStatus(true, 'Updated ' + when.toLocaleTimeString());
    } catch (e) {
      setPollStatus(false, 'Disconnected — ' + (e && e.message ? e.message : String(e)));
    } finally {
      setTimeout(poll, 30000);
    }
  }
  document.addEventListener('input', function(event) {
    var target = event.target;
    if (target && target.matches && target.matches('textarea[data-role^="reply-text-"]')) {
      persistReplyDraft(target);
    }
  });
  restorePersistedReplyDrafts(document);
  applyAgentFailureReadState();
  poll();
`;

// ---------------------------------------------------------------------------
// Lane-body render (pure) — shared by the full-page render AND the live
// server's /board JSON route
// ---------------------------------------------------------------------------

/** The four lane-body HTML fragments `renderDashboardHtml` embeds in the page. */
export interface LaneBodies {
  agentFailuresHtml: string;
  myLaneHtml: string;
  peerLaneHtml: string;
  reviewPoolHtml: string;
  /**
   * The Needs-you queue — every My-PR/Peer/Pool row with `needsYou` set,
   * rendered as a ✉/⚠ card (see `renderNeedsYouCard`). Grown onto `LaneBodies`
   * additively (the original three fields are never reshaped) so
   * `pr_triage_live_server.ts`'s `Parameters<typeof renderLaneBodies>[0]`
   * board-type trick keeps schema growth free — see that file's header.
   */
  needsYouHtml: string;
}

function renderAgentFailures(
  failures: AgentFailureEvent[],
  nowMs: number,
): string {
  if (failures.length === 0) {
    return `<div class="empty-state">No recent PR-triage agent failures.</div>`;
  }
  return `<div class="agent-failure-list">${
    failures.map((failure) => {
      const prs = failure.prNumbers?.length
        ? failure.prNumbers
        : failure.prNumber == null
        ? []
        : [failure.prNumber];
      const context = [
        prs.length ? `PR ${prs.map((n) => `#${n}`).join(", ")}` : "",
        failure.rootId == null ? "" : `thread ${failure.rootId}`,
        failure.occurrences
          ? `${failure.occurrences}× since ${
            relativeTime(failure.firstOccurredAt ?? "", nowMs) ||
            failure.firstOccurredAt
          }`
          : "",
      ].filter(Boolean).join(" · ");
      const ids = failure.invocationIds?.length
        ? failure.invocationIds
        : [failure.invocationId];
      const persistence = failure.persistenceStatus === "recorded"
        ? "invocation recorded"
        : "invocation output missing";
      return `<article class="agent-failure" data-invocation-id="${
        esc(failure.invocationId)
      }" data-invocation-ids="${esc(ids.join(" "))}">
      <div class="agent-failure-head"><span class="agent-failure-phase">${
        esc(failure.phase)
      }</span>${
        context
          ? `<span class="agent-failure-context">${esc(context)}</span>`
          : ""
      }</div>
      <div class="agent-failure-meta">${esc(failure.provider)}/${
        esc(failure.model)
      }${failure.operation ? ` · ${esc(failure.operation)}` : ""} · ${
        esc(
          relativeTime(failure.occurredAt, nowMs) || failure.occurredAt ||
            "unknown time",
        )
      } · ${esc(failure.failureClass)} · ${esc(persistence)}${
        failure.reportingFailed ? " · reporting/persistence failed" : ""
      }</div>
      <p class="agent-failure-reason">${esc(failure.failureReason)}</p>
      ${
        failure.outputPreview
          ? `<pre class="agent-failure-output">${
            esc(failure.outputPreview)
          }</pre>`
          : ""
      }
      ${
        failure.observabilityGap
          ? `<p class="agent-failure-gap"><strong>Observability gap:</strong> ${
            esc(failure.observabilityGap)
          }</p>`
          : ""
      }
      <button class="agent-failure-mark" type="button" onclick="markAgentFailuresRead(failureIds(this.closest('[data-invocation-id]')))">Mark read</button>
    </article>`;
    }).join("\n")
  }</div>`;
}

/**
 * Build the four lane-body HTML fragments (My PRs, Needs you, Peer PRs,
 * Review pool) from a PrBoard (or null/undefined for the empty-state — never
 * throws). This is the SAME logic `renderDashboardHtml` embeds inside the
 * full page — pulled out into its own pure function so
 * `pr_triage_live_server.ts`'s `/board` JSON route can hand the client just
 * the fragments (for in-place DOM patching) without reimplementing the
 * stack-grouping/sort/card-render pipeline. `renderDashboardHtml` calls this
 * directly, so there is ONE source of truth for lane-body HTML — never two
 * renderers to keep in sync.
 *
 * THE NEEDS-YOU PARTITION (the calm-redesign's core move): every row —
 * My-PR, Peer, or review-pool — with `needsYou` set is filtered OUT of its
 * home lane and INTO `needsYouHtml` instead, rendered via
 * `renderNeedsYouCard`. This happens BEFORE `groupIntoStacks`/stack-grouping
 * runs on the remainder, so a stack that loses a member to Needs-you still
 * groups its remaining calm members correctly (a stack of 3 where 1 PR needs
 * you renders as a stack of 2 in My PRs, and the pulled PR's OWN row —
 * outside any stack styling — appears in the queue). The three original
 * lanes therefore only ever contain CALM rows post-partition; the queue is
 * empty (empty-state: "No PRs need you right now.") whenever nothing needs
 * you.
 *
 * Pure: `nowMs` is injected (default Date.now()) so relative-time output is
 * deterministic in tests. Peer PR calm rows and review-pool calm rows are
 * both ordered health-first (red at top) then by prNumber, and both render
 * via the SAME `renderPeerRow` (the review pool is a `PeerRow[]`, so it
 * inherits the identical calm-row treatment for free). My PRs are grouped
 * into stacks via `groupIntoStacks` — see its doc comment for the
 * stack-vs-stack and within-stack ordering rules; a multi-PR stack renders as
 * one bordered group, a singleton renders as a bare row.
 */
export function renderLaneBodies(
  board: PrBoard | null | undefined,
  nowMs: number = Date.now(),
  repo: string = board?.repo ?? "",
): LaneBodies {
  const allMyPrs = board?.myPrs ?? [];
  const allPeerPrs = sortByHealthThenPr(board?.peerPrs ?? []);
  const allReviewPoolPrs = sortByHealthThenPr(board?.reviewPoolPrs ?? []);

  const myPrs = allMyPrs.filter((r) =>
    !r.needsYou || r.fixPreparation?.status === "running"
  );
  const peerPrs = allPeerPrs.filter((r) => !r.needsYou);
  const reviewPoolPrs = allReviewPoolPrs.filter((r) => !r.needsYou);

  // Needs-you queue order: red/yellow/unknown health first (mirrors the calm
  // lanes' own health-first convention), My-PR rows before Peer/Pool rows
  // (the owner's own work first), then by prNumber within each group — deterministic
  // and simple for Phase 1; a real priority model is a later-phase refinement.
  const needsYouRows: Array<MyPrRow | PeerRow> = [
    ...sortByHealthThenPr(
      allMyPrs.filter((r) =>
        r.needsYou && r.fixPreparation?.status !== "running"
      ),
    ),
    ...sortByHealthThenPr(allPeerPrs.filter((r) => r.needsYou)),
    ...sortByHealthThenPr(allReviewPoolPrs.filter((r) => r.needsYou)),
  ];

  const stackGroups = groupIntoStacks(myPrs);
  const agentFailuresHtml = renderAgentFailures(
    board?.agentFailures ?? [],
    nowMs,
  );

  const myLaneHtml = myPrs.length > 0
    ? `<div class="card-grid">${
      stackGroups.map((g) => renderStackGroup(g, nowMs, repo)).join("\n")
    }</div>`
    : `<div class="empty-state">No open PRs.</div>`;

  const needsYouHtml = needsYouRows.length > 0
    ? `<div class="card-grid">${
      needsYouRows.map((row) => renderNeedsYouCard(row, repo)).join("\n")
    }</div>`
    : `<div class="empty-state">No PRs need you right now.</div>`;

  const peerLaneHtml = peerPrs.length > 0
    ? `<div class="card-grid card-grid-compact">${
      peerPrs.map((r) => renderPeerRow(r, repo)).join("\n")
    }</div>`
    : `<div class="empty-state">No peer PRs surfaced.</div>`;

  const reviewPoolHtml = reviewPoolPrs.length > 0
    ? `<div class="card-grid card-grid-compact">${
      reviewPoolPrs.map((r) => renderPeerRow(r, repo)).join("\n")
    }</div>`
    : `<div class="empty-state">No cross-team PRs in the review pool.</div>`;

  return {
    agentFailuresHtml,
    myLaneHtml,
    needsYouHtml,
    peerLaneHtml,
    reviewPoolHtml,
  };
}

// ---------------------------------------------------------------------------
// Full-page render (pure) — the unit-tested entry point
// ---------------------------------------------------------------------------

/** Optional appearance overrides; only CSS custom properties with hex colors are accepted. */
export type DashboardTheme = {
  dark?: Record<string, string>;
  light?: Record<string, string>;
};

function themeCss(theme: DashboardTheme): string {
  const properties = (colors: Record<string, string> = {}) =>
    Object.entries(colors)
      .filter(([key, value]) =>
        /^[a-z][a-z-]*$/.test(key) &&
        /^#(?:[a-f0-9]{3}|[a-f0-9]{6})$/i.test(value)
      )
      .map(([key, value]) => `--${key}:${value}`).join(";");
  return `:root{${properties(theme.dark)}}:root[data-theme="light"]{${
    properties(theme.light)
  }}`;
}

/** Render the standalone dashboard shell using the same lanes as the live endpoint. */
export function renderDashboardHtml(
  board: PrBoard | null | undefined,
  nowMs: number = Date.now(),
  theme: DashboardTheme = {},
): string {
  const s: BoardSummary = board?.summary ?? {
    total: 0,
    red: 0,
    yellow: 0,
    green: 0,
    unknown: 0,
    needsAction: 0,
  };
  const scannedRel = relativeTime(board?.scannedAt ?? null, nowMs);
  const repo = board?.repo ?? "";

  const allMyPrs = board?.myPrs ?? [];
  const allPeerPrs = board?.peerPrs ?? [];
  const allReviewPoolPrs = board?.reviewPoolPrs ?? [];

  const {
    agentFailuresHtml: agentFailuresBody,
    myLaneHtml: myLaneBody,
    needsYouHtml: needsYouBody,
    peerLaneHtml: peerLaneBody,
    reviewPoolHtml: reviewPoolBody,
  } = renderLaneBodies(board, nowMs, repo);
  const agentFailureCount = board?.agentFailures?.length ?? 0;

  // Lane-heading counts reflect the POST-PARTITION calm-row counts (a PR
  // pulled into Needs-you no longer counts toward its home lane's heading) —
  // computed the same way renderLaneBodies partitions internally, so the
  // headings and the rendered rows always agree.
  const myPrs = allMyPrs.filter((r) =>
    !r.needsYou || r.fixPreparation?.status === "running"
  );
  const peerPrs = allPeerPrs.filter((r) => !r.needsYou);
  const reviewPoolPrs = allReviewPoolPrs.filter((r) => !r.needsYou);
  const needsYouCount =
    allMyPrs.filter((r) => r.needsYou && r.fixPreparation?.status !== "running")
      .length +
    allPeerPrs.filter((r) => r.needsYou).length +
    allReviewPoolPrs.filter((r) => r.needsYou).length;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PR & CI Triage</title>
<style>${STYLE}${themeCss(theme)}</style>
<script>
  // Pre-paint: honor a saved "show addressed" preference before first paint so
  // the page never flashes addressed content when the user has opted to hide it
  // (the default) NOR flashes it hidden-then-shown when they've opted to show.
  // Runs against documentElement because <body> isn't parsed yet at <head> time;
  // a matching line in the main script re-syncs <body> + the checkbox on load.
  try {
    if (sessionStorage.getItem("pr-triage:show-addressed") === "1") {
      document.documentElement.dataset.showAddressed = "1";
    }
    if (localStorage.getItem("pr-triage:theme") === "light") {
      document.documentElement.dataset.theme = "light";
    }
  } catch (_e) { /* sessionStorage unavailable — default (hide) is fine */ }
</script>
</head>
<body class="hide-addressed">
  <div class="wrap">
    <header class="page">
      <p class="kicker">Live · auto-updates every 30s</p>
      <h1>PR &amp; CI Triage</h1>
      <p class="scanned-at">${repo ? `${esc(repo)} · ` : ""}Scanned ${
    scannedRel ? esc(scannedRel) : "—"
  } · <span id="poll-status" class="poll-status poll-status-pending"><span class="poll-dot" aria-hidden="true"></span><span id="poll-status-text">Connecting…</span></span></p>
      <div class="summary-strip">
        <span class="pill pill-total"><b>${s.total}</b> total</span>
        <span class="pill pill-action"><b>${s.needsAction}</b> needs action</span>
        <span class="pill pill-red"><b>${s.red}</b> red</span>
        <span class="pill pill-yellow"><b>${s.yellow}</b> yellow</span>
        <span class="pill pill-green"><b>${s.green}</b> green</span>
      </div>
      <div class="view-controls">
        <label class="toggle-addressed">
          <input type="checkbox" id="show-addressed-toggle">
          <span>Show addressed feedback</span>
        </label>
        <label class="toggle-theme">
          <input type="checkbox" id="light-mode-toggle">
          <span>Light mode</span>
        </label>
      </div>
      <details class="agent-failure-center">
        <summary aria-label="Agent failures" title="Agent failures"><span aria-hidden="true">⚠</span><span id="agentfailures-lane-count" class="agent-failure-unread">${agentFailureCount}</span></summary>
        <div class="agent-failure-popover">
          <div class="agent-failure-toolbar"><strong>Agent failures</strong><span id="agent-failure-status" class="agent-failure-status"></span><button class="agent-failure-mark" type="button" onclick="markAllAgentFailuresRead()">Mark all read</button></div>
          <p id="agent-failures-all-read" class="agent-failures-all-read">You’re caught up. New failures will appear here.</p>
          <div id="agent-failures-body">${agentFailuresBody}</div>
        </div>
      </details>
    </header>

    <section class="lane lane-needsyou">
      <h2>Needs you <span id="needsyou-lane-count" class="lane-count">${needsYouCount}</span></h2>
      <p class="lane-subtitle">Empty most of the time — a PR drops here only when it genuinely needs you.</p>
      <div id="needsyou-lane-body">${needsYouBody}</div>
    </section>

    <section class="lane">
      <h2>My PRs <span id="my-lane-count" class="lane-count">${myPrs.length}</span></h2>
      <div id="my-lane-body">${myLaneBody}</div>
    </section>

    <section class="lane">
      <h2>Peer PRs <span id="peer-lane-count" class="lane-count">${peerPrs.length}</span></h2>
      <div id="peer-lane-body">${peerLaneBody}</div>
    </section>

    <section class="lane">
      <h2>Review pool <span id="reviewpool-lane-count" class="lane-count">${reviewPoolPrs.length}</span></h2>
      <p class="lane-subtitle">Open PRs across other teams you can pick up.</p>
      <div id="reviewpool-lane-body">${reviewPoolBody}</div>
    </section>

    <footer class="page-footer">Live board · refreshes every 30s without replacing your unsaved reply drafts.</footer>
  </div>
  <script>${SCRIPT}</script>
</body>
</html>
`;
}

export type TourStatus = "building" | "ready" | "stale" | "failed";

export interface TourState {
  prNumber: number;
  /** Head SHAs (first 12 characters) that have a rendered tour page. */
  pageShas: string[];
  /** The latest pr-tour workflow run for this PR, if any. */
  run?: { status: "running" | "failed" | "succeeded"; startedAt?: string };
}

/** A pr-tour run still "running" after this long is treated as dead. */
const TOUR_RUN_STALE_MS = 20 * 60_000;
/** The tour state a card shows for its PR's current head. Pure. */
export function tourStatusFor(
  headSha: string,
  state: TourState | undefined,
  nowMs: number,
): TourStatus | undefined {
  if (!state) return undefined;
  const run = state.run;
  if (
    run?.status === "running" &&
    nowMs - Date.parse(run.startedAt ?? "") < TOUR_RUN_STALE_MS
  ) {
    return "building";
  }
  if (state.pageShas.includes(headSha.slice(0, 12))) return "ready";
  if (run?.status === "failed") return "failed";
  return state.pageShas.length > 0 ? "stale" : undefined;
}

/** Add tour state to every PR row without mutating the board. Pure. */
export function enrichBoardWithTours(
  board: PrBoard | null,
  states: TourState[],
  nowMs: number,
): PrBoard | null {
  if (!board) return null;
  const byPr = new Map(states.map((state) => [state.prNumber, state]));
  const withTour = <
    R extends { prNumber: number; headSha?: string; tour?: TourStatus },
  >(
    row: R,
  ): R => {
    const tour = tourStatusFor(
      row.headSha ?? "",
      byPr.get(row.prNumber),
      nowMs,
    );
    return tour ? { ...row, tour } : row;
  };
  return {
    ...board,
    myPrs: board.myPrs.map(withTour),
    peerPrs: board.peerPrs.map(withTour),
    reviewPoolPrs: board.reviewPoolPrs?.map(withTour),
  };
}
