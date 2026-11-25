/** Separate local experiment. The read-only model remains unchanged. */
import { z } from "npm:zod@4.1.12";
import { runPython } from "./_lib/process.ts";

const Path = z.string().startsWith("/").max(4096);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Arguments = z.object({
  runId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  deviceUuid: z.string().regex(
    /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/,
  ).meta({ sensitive: true }),
  expectedSha256: Digest,
  ownerConfirmed: z.literal(true),
  inactiveChannel30Confirmed: z.literal(true),
  radioReadyConfirmed: z.literal(true).describe(
    "Owner confirms charged radio on with Bluetooth, scan stopped, VOX off, other radios off and phone apps disconnected.",
  ),
  programmingAuthorized: z.literal(true),
});
const Globals = z.object({ pythonPath: Path, privateRoot: Path });
const RestoreArguments = Arguments.extend({
  originalCapturePath: Path.meta({ sensitive: true }),
  originalSha256: Digest,
});
const Receipt = z.object({
  status: z.literal("restored-and-verified"),
  completeRestoreBackup: z.literal(false),
  settingsRestored: z.literal(true),
  firmware: z.literal("Unknown"),
  originalSha256: Digest,
  testSha256: Digest,
  privatePath: Path,
  writes: z.literal(2),
}).strict();
const RestoreReceipt = Receipt.extend({
  status: z.literal("restoration-readback-verified"),
  writes: z.literal(1),
  persistenceVerified: z.literal(false),
}).strict();
interface Context {
  globalArgs: z.infer<typeof Globals>;
  extensionFile(relativePath: string): string;
  signal?: AbortSignal;
  writeResource(
    spec: string,
    name: string,
    data: z.infer<typeof Receipt> | z.infer<typeof RestoreReceipt>,
  ): Promise<unknown>;
}

async function execute(
  input: Record<string, unknown>,
  context: Context,
  schema: typeof Receipt | typeof RestoreReceipt,
) {
  const globals = Globals.parse(context.globalArgs);
  const output = await runPython(
    globals.pythonPath,
    context.extensionFile("runtime/programming.py"),
    globals.privateRoot,
    input,
    context.signal,
    250_000,
  );
  if (!output.success) {
    throw new Error(
      "TD-H3 experiment failed; stop and inspect private evidence. Outcome may be ambiguous; no blind retry.",
    );
  }
  let receipt;
  try {
    receipt = z.object({ ok: z.literal(true), result: schema }).strict()
      .parse(JSON.parse(new TextDecoder().decode(output.stdout))).result;
  } catch {
    throw new Error(
      "Invalid experiment receipt; inspect private evidence before any further operation.",
    );
  }
  context.signal?.throwIfAborted();
  const handle = await context.writeResource(
    "receipt",
    input.runId as string,
    receipt,
  );
  context.signal?.throwIfAborted();
  return { dataHandles: [handle] };
}

/** Narrow experimental writer, distinct from any profile programmer. */
export const model = {
  type: "@mgreten/tdh3-programming-experiment",
  version: "2026.11.14.4",
  globalArguments: Globals,
  resources: {
    receipt: {
      description:
        "Verified label restoration receipt, no raw radio configuration.",
      schema: z.union([Receipt, RestoreReceipt]),
      lifetime: "30d",
      garbageCollection: 20,
    },
  },
  methods: {
    labelExperiment: {
      description:
        "Authorized one-byte channel30 label test followed by guarded restoration. Writes only block0x0E20, requires physical inactive-state confirmation and fresh reviewed capture digest. On failure stop and inspect private evidence; never blindly retry. Not a full backup or general programmer.",
      arguments: Arguments,
      async execute(args: Record<string, unknown>, context: Context) {
        return await execute(Arguments.parse(args), context, Receipt);
      },
    },
    restoreLabel: {
      description:
        "Inverse-only recovery of the experimental channel30 label byte58 to38, never a forward test. Requires validated original capture and exact fresh two-pass full-covered postimage; writes once, verifies ACK and all covered bytes. Receipt proves in-session readback only; independently capture again in a new process for persistence. On any failure inspect private diagnostics, never retry blindly.",
      arguments: RestoreArguments,
      async execute(args: Record<string, unknown>, context: Context) {
        return await execute(
          { ...RestoreArguments.parse(args), operation: "restoreLabel" },
          context,
          RestoreReceipt,
        );
      },
    },
  },
};
