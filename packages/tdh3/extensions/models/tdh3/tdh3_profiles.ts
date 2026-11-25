/** GMRS-only erased-slot allocation, separate from read-only and label tools. */
import { z } from "npm:zod@4.1.12";
import { runPython } from "./_lib/process.ts";

const Path = z.string().startsWith("/").max(4096);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Profile = z.object({
  slot: z.number().int().min(31).max(40),
  label: z.string().regex(/^[A-Z0-9 -]{1,8}$/),
  rxHz: z.number().int().min(462550000).max(462725000)
    .refine((hz) => (hz - 462550000) % 25000 === 0),
  txToneTenths: z.union([
    z.literal(797),
    z.literal(825),
    z.literal(1000),
    z.literal(1072),
    z.literal(1413),
    z.literal(2035),
  ]),
}).strict();
const Arguments = z.object({
  runId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  capturePath: Path.meta({ sensitive: true }),
  expectedSha256: Digest,
  trustPolicy: z.literal("owner-reviewed-sha256-exact-gmrs-coverage-v1"),
  profiles: z.array(Profile).min(1).max(10).meta({ sensitive: true }),
});
const Globals = z.object({ pythonPath: Path, privateRoot: Path });
const Receipt = z.object({
  status: z.literal("offline-preview-only"),
  privatePath: Path,
  profiles: z.number().int().min(1).max(10),
  blocks: z.number().int().min(4).max(11),
  partialCapture: z.literal(true),
  completeRestoreBackup: z.literal(false),
  firmwareAllocationVerified: z.literal(false),
}).strict();
const ApplyArguments = z.object({
  runId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  deviceUuid: z.string().regex(
    /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/,
  )
    .meta({ sensitive: true }),
  planPath: Path.meta({ sensitive: true }),
  planSha256: Digest,
  capturePath: Path.meta({ sensitive: true }),
  expectedSha256: Digest,
  trustPolicy: z.literal("owner-reviewed-sha256-exact-gmrs-coverage-v1"),
  ownerConfirmed: z.literal(true),
  radioReadyConfirmed: z.literal(true),
  inactiveTargetSlotsConfirmed: z.literal(true),
  programmingAuthorized: z.literal(true),
});
const ApplyReceipt = z.object({
  status: z.literal("allocation-readback-verified"),
  privatePath: Path,
  profiles: z.number().int().min(1).max(10),
  writes: z.number().int().min(4).max(11),
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
    data: z.infer<typeof Receipt> | z.infer<typeof ApplyReceipt>,
  ): Promise<unknown>;
}

async function execute(
  input: Record<string, unknown>,
  context: Context,
  script: string,
  schema: typeof Receipt | typeof ApplyReceipt,
) {
  const globals = Globals.parse(context.globalArgs);
  const output = await runPython(
    globals.pythonPath,
    context.extensionFile(script),
    globals.privateRoot,
    input,
    context.signal,
    script === "runtime/allocation.py" ? 610_000 : 200_000,
  );
  if (!output.success) {
    throw new Error(
      "TD-H3 profile operation failed. Inspect private evidence; any write outcome may be ambiguous. No blind retry.",
    );
  }
  let receipt;
  try {
    receipt = z.object({ ok: z.literal(true), result: schema }).strict()
      .parse(JSON.parse(new TextDecoder().decode(output.stdout))).result;
  } catch {
    throw new Error(
      "Invalid TD-H3 profile receipt; inspect private evidence before proceeding.",
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

/**
 * Allocate only erased GMRS slots31–40 from validated factory RPT templates.
 * Every block has one attempt and exact readback; failure never blind-retries
 * or rolls back. Persistence and RF transmit capability are separate claims.
 */
export const model = {
  type: "@mgreten/tdh3-profiles",
  version: "2026.11.14.4",
  globalArguments: Globals,
  resources: {
    receipt: {
      description:
        "Allocation preview or in-session readback receipt; no profile details or radio bytes.",
      schema: z.union([Receipt, ApplyReceipt]),
      lifetime: "30d",
      garbageCollection: 20,
    },
  },
  methods: {
    preview: {
      description:
        "Offline preview only, never connects or writes. Validates trusted partial capture and allocates erased slots31–40 from exact matching factory GMRS repeater records. Derives +5MHz input, RX filterOff, High/Wide stored codes, scan inclusion. Private plan records precise block diffs; firmware acceptance and access permission remain unverified.",
      arguments: Arguments,
      async execute(args: Record<string, unknown>, context: Context) {
        return await execute(
          Arguments.parse(args),
          context,
          "runtime/profiles.py",
          Receipt,
        );
      },
    },
    apply: {
      description:
        "Apply only a reviewed erased-slot31–40 GMRS allocation plan, regenerated from a trusted capture; no arbitrary frames. Requires explicit owner radio/charged/Bluetooth/scan-stopped/VOXOff/disconnected-apps and inactive target slots confirmation. Fresh exact identity/fullcovered preimage, single-use ordered block writes, ACK/two target reads and fullcovered checks after every block. Ambiguity stops without retry/rollback. In-session readback is not persistence; verify with separate-process capture/decode.",
      arguments: ApplyArguments,
      async execute(args: Record<string, unknown>, context: Context) {
        return await execute(
          ApplyArguments.parse(args),
          context,
          "runtime/allocation.py",
          ApplyReceipt,
        );
      },
    },
  },
};
