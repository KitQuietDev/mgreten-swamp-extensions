import { z } from "npm:zod@4";
export const CI_STATES = [
  "pending",
  "success",
  "failure",
  "neutral",
  "unknown",
] as const;
export type CiState = (typeof CI_STATES)[number];

export const HEALTH_STATES = ["red", "yellow", "green", "unknown"] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

const FailingCheckRowSchema = z.object({
  name: z.string(),
  source: z.string(),
  failureClass: z.string(),
  detailsUrl: z.string(),
});
const IncomingFeedbackThreadSchema = z.object({
  rootId: z.number().int().positive(),

  kind: z.enum(["inline", "issue_comment", "review"]),
  author: z.string(),
  authorType: z.enum(["human", "bot", "author"]),
  path: z.string(),
  line: z.number().nullable(),

  body: z.string(),
  createdAt: z.string(),

  status: z.enum([
    "likely_addressed",
    "addressed_by_commit",
    "likely_unaddressed",
  ]),
});

export type IncomingFeedbackThread = z.infer<
  typeof IncomingFeedbackThreadSchema
>;

const TweakAgentFailureSchema = z.object({
  stage: z.enum(["dispatch", "agent", "capture"]),
  summary: z.string(),
  detail: z.string().optional(),
  retryable: z.boolean(),
  failureClass: z.string().optional(),
  invocationId: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  exitCode: z.number().optional(),
  timedOut: z.boolean().optional(),
});
const NeedsYouSchema = z.object({
  kind: z.enum(["reply", "decision", "glance"]),

  summary: z.string().optional(),
});

export type NeedsYou = z.infer<typeof NeedsYouSchema>;

const IssueLinkSchema = z.object({
  identifier: z.string(),
  title: z.string(),
  url: z.url({ protocol: /^https?$/ }),
}).strict();

export type IssueLink = z.infer<typeof IssueLinkSchema>;

const MyPrRowSchema = z.object({
  prNumber: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  headRef: z.string(),

  tour: z.enum(["building", "ready", "stale", "failed"]).optional(),
  headSha: z.string().optional(),

  additions: z.number().optional(),
  deletions: z.number().optional(),
  isDraft: z.boolean(),

  issueLinks: z.array(IssueLinkSchema).optional(),
  ciState: z.enum(CI_STATES),
  failingChecks: z.array(FailingCheckRowSchema),
  reviewState: z.string(),

  unaddressedCount: z.number(),

  needsVerificationCount: z.number(),
  hasDraftReply: z.boolean(),
  draftReplyCount: z.number(),

  reviewThreads: z.array(z.object({
    rootId: z.number().int().positive(),
    path: z.string(),
    line: z.number().nullable(),
    comments: z.array(z.object({
      author: z.string(),
      authorType: z.string(),
      body: z.string(),
      createdAt: z.string(),
    })),
    diffHunk: z.string().optional(),
    valid: z.boolean(),
    category: z.string(),
    suggestedReply: z.string(),
    suggestedFix: z.object({ files: z.array(z.string()), sketch: z.string() })
      .nullable(),
    confidence: z.string(),
    posted: z.boolean(),
    postedBody: z.string().optional(),
    triageInstance: z.string(),
  })),

  unpreparedFixRootIds: z.array(z.number()).optional(),

  incomingFeedback: z.array(IncomingFeedbackThreadSchema),

  triageInstance: z.string().optional(),
  health: z.enum(HEALTH_STATES),
  lastActivityAt: z.string().optional(),

  stackId: z.string(),

  stackPos: z.number(),

  stackSize: z.number(),

  hasTweak: z.boolean().optional(),

  tweakChangedFiles: z.number().optional(),

  tweakAgentSuccess: z.boolean().optional(),

  tweakRanAt: z.string().optional(),

  tweakWorktreePath: z.string().optional(),

  tweakDiffStat: z.string().optional(),

  tweakDiff: z.string().optional(),

  tweakInstruction: z.string().optional(),

  tweakFailure: TweakAgentFailureSchema.optional(),

  tweakPushed: z.boolean().optional(),

  tweakPushSummary: z.string().optional(),

  hasCiFix: z.boolean().optional(),

  ciFixChangedFiles: z.number().optional(),

  ciFixAgentSuccess: z.boolean().optional(),

  ciFixWorktreePath: z.string().optional(),

  ciFixRanAt: z.string().optional(),

  ciFixDiffStat: z.string().optional(),

  ciFixDiff: z.string().optional(),

  ciFixInstruction: z.string().optional(),

  ciFixFailure: TweakAgentFailureSchema.optional(),

  ciFixPushed: z.boolean().optional(),

  ciFixPushSummary: z.string().optional(),

  needsYou: NeedsYouSchema.optional(),
  fixPreparation: z.object({
    status: z.enum(["running", "failed"]),
    startedAt: z.string().optional(),
    error: z.string().optional(),
  }).optional(),
});

const PeerRowSchema = z.object({
  prNumber: z.number().int().positive(),
  author: z.string(),
  title: z.string(),
  url: z.string(),
  tour: z.enum(["building", "ready", "stale", "failed"]).optional(),
  headSha: z.string(),
  reason: z.enum(["new", "changed"]),

  additions: z.number().optional(),
  deletions: z.number().optional(),

  issueLinks: z.array(IssueLinkSchema).optional(),
  hasDraft: z.boolean(),
  draftStatus: z.string().optional(),
  health: z.enum(HEALTH_STATES),

  needsYou: NeedsYouSchema.optional(),
});

const BoardSummarySchema = z.object({
  total: z.number(),
  red: z.number(),
  yellow: z.number(),
  green: z.number(),
  unknown: z.number(),

  needsAction: z.number(),
});

const AgentFailureEventSchema = z.object({
  invocationId: z.string(),
  phase: z.string(),
  prNumber: z.number().int().positive().optional(),
  rootId: z.number().int().positive().optional(),
  provider: z.string(),
  model: z.string(),
  occurredAt: z.string(),
  failureClass: z.string(),
  failureReason: z.string(),
  outputPreview: z.string().optional(),
  operation: z.string().optional(),
  persistenceStatus: z.enum(["recorded", "missing-invocation"]),
  reportingFailed: z.boolean(),
  observabilityGap: z.string().optional(),

  occurrences: z.number().optional(),
  firstOccurredAt: z.string().optional(),
  prNumbers: z.array(z.number()).optional(),

  invocationIds: z.array(z.string()).optional(),
});
/** Version 1 of a dashboard snapshot. */
export const BoardSchema = z.object({
  schemaVersion: z.literal(1),
  scannedAt: z.string(),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  summary: BoardSummarySchema,
  myPrs: z.array(MyPrRowSchema),
  peerPrs: z.array(PeerRowSchema),

  reviewPoolPrs: z.array(PeerRowSchema).optional(),

  agentFailures: z.array(AgentFailureEventSchema).optional(),
});

/** The validated board snapshot. */
export type PrBoard = z.infer<typeof BoardSchema>;
/** The viewer's own PR card. */
export type MyPrRow = z.infer<typeof MyPrRowSchema>;
/** A peer or review pool card. */
export type PeerRow = z.infer<typeof PeerRowSchema>;
/** Board-wide counts. */
export type BoardSummary = z.infer<typeof BoardSummarySchema>;
/** A failed agent invocation shown in the diagnostics popover. */
export type AgentFailureEvent = z.infer<typeof AgentFailureEventSchema>;
/** A thread with a proposed reply or fix. */
export type ReviewThreadRow = MyPrRow["reviewThreads"][number];
/** Diagnostics for a failed tweak. */
export type AgentFailure = z.infer<typeof TweakAgentFailureSchema>;
