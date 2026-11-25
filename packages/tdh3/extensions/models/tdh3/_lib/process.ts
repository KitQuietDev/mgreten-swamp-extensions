/** Supervise one direct child; termination contains resources, not radio state. */
export async function supervise(
  command: Deno.Command,
  input: Uint8Array,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  graceMs = 5_000,
): Promise<Deno.CommandOutput> {
  if (signal?.aborted) {
    throw new Error("TD-H3 operation canceled before launch");
  }
  const child = command.spawn();
  let stopped = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    // Python handles TERM cooperatively, stopping further writes and unwinding.
    // A stuck interpreter/cleanup must not retain the lock indefinitely.
    try {
      child.kill("SIGTERM");
    } catch { /* Already exited. */ }
    killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch { /* Already exited. */ }
    }, graceMs);
  };
  const timer = setTimeout(stop, timeoutMs);
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  const writer = child.stdin.getWriter();
  const output = child.output(); // Drain both output pipes while writing stdin.
  try {
    const [, result] = await Promise.all([
      (async () => {
        if (stopped) throw new Error("Canceled");
        await writer.write(input);
        await writer.close();
      })(),
      output,
    ]);
    if (stopped || signal?.aborted) throw new Error("Canceled or timed out");
    return result;
  } catch {
    stop();
    throw new Error(
      "TD-H3 subprocess stopped or failed; outcome may be unknown. Inspect private evidence; no retry or automatic rollback. Termination is not restoration.",
    );
  } finally {
    // Never abandon a direct child on pipe failure or cancellation. The hard
    // containment timer remains armed until exit/output cleanup has completed.
    await child.status;
    await output.catch(() => {});
    clearTimeout(timer);
    if (killTimer !== undefined) clearTimeout(killTimer);
    signal?.removeEventListener("abort", stop);
    writer.releaseLock();
  }
}

/** Execute bundled Python without a shell or user-selected CLI switches. */
export function runPython(
  pythonPath: string,
  script: string,
  privateRoot: string,
  request: unknown,
  signal: AbortSignal | undefined,
  timeoutMs: number,
) {
  return supervise(
    new Deno.Command(pythonPath, {
      args: ["-B", script],
      env: { TDH3_PRIVATE_ROOT: privateRoot },
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }),
    new TextEncoder().encode(JSON.stringify(request)),
    signal,
    timeoutMs,
  );
}
