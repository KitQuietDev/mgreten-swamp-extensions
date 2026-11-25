/** Local-only TD-H3 GMRS discovery, guarded partial capture, and offline decode. */
import { z } from "npm:zod@4.1.12";
import { runPython } from "./_lib/process.ts";

const AbsolutePath = z.string().startsWith("/").max(4096);
const RunId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Globals = z.object({
  pythonPath: AbsolutePath.describe(
    "Absolute path to a Python virtualenv with the package's pinned dependencies.",
  ),
  privateRoot: AbsolutePath.describe(
    "Existing owner-only evidence directory outside any Git checkout; never a shared datastore.",
  ),
});
const Discover = z.object({
  runId: RunId,
  bluetoothAuthorized: z.literal(true).describe(
    "Fresh authorization to scan nearby Bluetooth advertisements without connecting.",
  ),
});
const Capture = Discover.extend({
  bluetoothAuthorized: z.literal(true).describe(
    "Fresh authorization to locate and connect to the explicitly confirmed radio for two partial reads.",
  ),
  // CoreBluetooth peripheral UUIDs are not restricted to RFC variant bits.
  deviceUuid: z.string().regex(
    /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/,
  ).meta({ sensitive: true }).describe(
    "Explicit Mac peripheral UUID reviewed by the owner; never selected by name, count or RSSI.",
  ),
  confirmedRadioLabel: z.literal("2A4FBTD831G"),
  ownerConfirmed: z.literal(true).describe(
    "Owner has mapped this exact UUID to their physical TD-H3 GMRS. Names and model identity do not authenticate ownership.",
  ),
});
const Decode = z.object({
  runId: RunId,
  capturePath: AbsolutePath,
  expectedSha256: Digest.describe(
    "Owner-reviewed digest, independently supplied rather than implicitly trusted from the input manifest.",
  ),
  trustPolicy: z.literal("owner-reviewed-sha256-exact-gmrs-coverage-v1"),
});
const ReceiptBase = z.object({
  privatePath: AbsolutePath,
  completeRestoreBackup: z.literal(false),
  firmware: z.literal("Unknown"),
  liveChannel: z.literal("Unknown"),
}).strict();
const Receipt = z.discriminatedUnion("operation", [
  ReceiptBase.extend({
    operation: z.literal("discover"),
    partialCapture: z.literal(false),
    candidateCount: z.number().int().nonnegative(),
  }),
  ReceiptBase.extend({
    operation: z.literal("capture"),
    partialCapture: z.literal(true),
    sha256: Digest,
    blocksPerPass: z.literal(171),
    bytesPerPass: z.literal(5472),
  }),
  ReceiptBase.extend({
    operation: z.literal("decode"),
    partialCapture: z.literal(true),
    sha256: Digest,
    populated: z.number().int().min(0).max(199),
    empty: z.number().int().min(0).max(199),
    unknowns: z.array(z.string()),
  }),
]);

interface Context {
  globalArgs: z.infer<typeof Globals>;
  extensionFile(relativePath: string): string;
  signal?: AbortSignal;
  logger: { info(message: string): void };
  writeResource(
    spec: string,
    name: string,
    data: z.infer<typeof Receipt>,
  ): Promise<unknown>;
}

async function execute(
  operation: "discover" | "capture" | "decode",
  args: Record<string, unknown>,
  context: Context,
) {
  const globals = Globals.parse(context.globalArgs);
  const schema =
    { discover: Discover, capture: Capture, decode: Decode }[operation];
  // Swamp merges global arguments into args; only declared method fields cross
  // the stdin boundary. No shell interpolation and no arbitrary CLI switches.
  const input = schema.parse(args);
  context.signal?.throwIfAborted();
  context.logger.info("Starting local TD-H3 read-only operation");
  const output = await runPython(
    globals.pythonPath,
    context.extensionFile("runtime/bridge.py"),
    globals.privateRoot,
    { operation, ...input },
    context.signal,
    200_000,
  );
  if (!output.success) {
    let code = "operation_failed";
    try {
      const failure = JSON.parse(new TextDecoder().decode(output.stderr));
      const parsed = z.enum([
        "operation_failed",
        "unsafe_path",
        "unsafe_permissions",
        "input_too_large",
        "source_changed",
        "coverage_mismatch",
        "capture_recorded_error",
        "invalid_arguments",
        "invalid_run_id",
        "bluetooth_not_authorized",
        "device_confirmation_required",
        "trust_policy_required",
        "output_exists",
        "bluetooth_busy",
      ]).safeParse(failure.code);
      if (parsed.success) code = parsed.data;
    } catch { /* Never echo private subprocess diagnostics. */ }
    throw new Error(
      `TD-H3 ${operation}: ${code}; inspect private output before retrying; use a new runId after a partial failure.`,
    );
  }
  let receipt: z.infer<typeof Receipt>;
  try {
    receipt = z.object({ ok: z.literal(true), result: Receipt }).strict()
      .parse(JSON.parse(new TextDecoder().decode(output.stdout))).result;
  } catch {
    throw new Error("TD-H3 invalid_bridge_response; no receipt persisted");
  }
  if (receipt.operation !== operation) {
    throw new Error("TD-H3 operation mismatch");
  }
  context.signal?.throwIfAborted();
  const handle = await context.writeResource(
    "receipt",
    input.runId,
    receipt,
  );
  context.logger.info("Local TD-H3 read-only operation completed");
  context.signal?.throwIfAborted();
  return { dataHandles: [handle] };
}

/** Local partial-read/validated offline-decode contract; never permits config W. */
export const model = {
  type: "@mgreten/tdh3-readonly",
  version: "2026.11.14.4",
  globalArguments: Globals,
  resources: {
    receipt: {
      description:
        "Local private-file receipt only; no raw radio configuration or device identifiers.",
      schema: Receipt,
      lifetime: "30d",
      garbageCollection: 20,
    },
  },
  methods: {
    discover: {
      description:
        "Authorized Bluetooth scan only. Candidates stay in private candidates.json; no selection or connection is made.",
      arguments: Discover,
      execute: (args: Record<string, unknown>, context: Context) =>
        execute("discover", args, context),
    },
    capture: {
      description:
        "Connect to an explicitly owner-confirmed UUID, require exact GMRS identity, and save two matching partial reads. Not a complete/restorable backup.",
      arguments: Capture,
      execute: (args: Record<string, unknown>, context: Context) =>
        execute("capture", args, context),
    },
    decode: {
      description:
        "Offline validation and private JSON/CSV decode with explicit digest, exact GMRS identity and fixed partial coverage. High/Low are stored codes, not measured watts. No Bluetooth.",
      arguments: Decode,
      execute: (args: Record<string, unknown>, context: Context) =>
        execute("decode", args, context),
    },
  },
};
