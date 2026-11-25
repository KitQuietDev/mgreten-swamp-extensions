/** Separate narrow listening setting; not an arbitrary settings editor. */
import { z } from "npm:zod@4.1.12";
import { runPython } from "./_lib/process.ts";

const Path = z.string().startsWith("/").max(4096);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Preview = z.object({
  runId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  capturePath: Path.meta({ sensitive: true }),
  expectedSha256: Digest,
  trustPolicy: z.literal("owner-reviewed-sha256-exact-gmrs-coverage-v1"),
});
const Apply = Preview.extend({
  deviceUuid: z.string().regex(
    /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/,
  )
    .meta({ sensitive: true }),
  planPath: Path.meta({ sensitive: true }),
  planSha256: Digest,
  ownerConfirmed: z.literal(true),
  radioReadyConfirmed: z.literal(true),
  programmingAuthorized: z.literal(true),
});
const Globals = z.object({ pythonPath: Path, privateRoot: Path });
const PreviewReceipt = z.object({
  status: z.literal("offline-squelch-preview-only"),
  privatePath: Path,
  completeRestoreBackup: z.literal(false),
}).strict();
const ApplyReceipt = z.object({
  status: z.literal("squelch-readback-verified"),
  privatePath: Path,
  writes: z.literal(1),
  afterSha256: Digest,
  completeRestoreBackup: z.literal(false),
  persistenceVerified: z.literal(false),
}).strict();
interface Context {
  globalArgs: z.infer<typeof Globals>;
  extensionFile(relativePath: string): string;
  signal?: AbortSignal;
  writeResource(
    spec: string,
    name: string,
    data: z.infer<typeof PreviewReceipt> | z.infer<typeof ApplyReceipt>,
  ): Promise<unknown>;
}

async function execute(
  args: Record<string, unknown>,
  context: Context,
  write: boolean,
) {
  const input = (write ? Apply : Preview).parse(args);
  const globals = Globals.parse(context.globalArgs);
  const output = await runPython(
    globals.pythonPath,
    context.extensionFile("runtime/listening.py"),
    globals.privateRoot,
    { ...input, operation: write ? "setSquelch" : "previewSquelch" },
    context.signal,
    write ? 610_000 : 200_000,
  );
  if (!output.success) {
    throw new Error(
      "TD-H3 squelch operation failed; inspect private evidence. No blind retry or rollback.",
    );
  }
  let receipt;
  try {
    receipt = z.object({
      ok: z.literal(true),
      result: write ? ApplyReceipt : PreviewReceipt,
    })
      .strict().parse(JSON.parse(new TextDecoder().decode(output.stdout)))
      .result;
  } catch {
    throw new Error(
      "Invalid squelch receipt; inspect private evidence before proceeding.",
    );
  }
  context.signal?.throwIfAborted();
  const handle = await context.writeResource("receipt", input.runId, receipt);
  context.signal?.throwIfAborted();
  return { dataHandles: [handle] };
}

/**
 * Fixed squelch5→2 preview/apply contract, not a general settings editor.
 * Apply verifies the exact trusted preimage and VOXOff; an in-session receipt
 * must be followed by independent capture/decode to establish persistence.
 */
export const model = {
  type: "@mgreten/tdh3-listening",
  version: "2026.11.14.4",
  globalArguments: Globals,
  resources: {
    receipt: {
      description:
        "Squelch-only preview or in-session verification, no raw settings.",
      schema: z.union([PreviewReceipt, ApplyReceipt]),
      lifetime: "30d",
      garbageCollection: 20,
    },
  },
  methods: {
    previewSquelch: {
      description:
        "Offline preview of exactly squelch5 to2 at0xCA9. Requires trusted captured preimage and VOXOff. No Bluetooth, no other setting changes.",
      arguments: Preview,
      async execute(args: Record<string, unknown>, context: Context) {
        return await execute(args, context, false);
      },
    },
    setSquelch: {
      description:
        "Apply only the reviewed squelch5 to2 plan. Explicit same-radio owner/physical readiness and programming authorization, trusted hash, regenerated plan, fresh exact identity/fullcovered preimage and VOXOff required. One W to0xCA0, onlyoffset9 changes, ACK/double target/fullcovered readback, no retry/rollback. Receipt is not persistence: separately capture/decode. No other settings, RF or unlock methods.",
      arguments: Apply,
      async execute(args: Record<string, unknown>, context: Context) {
        return await execute(args, context, true);
      },
    },
  },
};
