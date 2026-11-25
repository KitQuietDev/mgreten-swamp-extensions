/** Execute real model methods with caller cancellation, no Swamp signal mocks. */
import { supervise } from "../extensions/models/tdh3/_lib/process.ts";
const config = JSON.parse(await Deno.readTextFile(Deno.args[0]));
const controller = new AbortController();
let receipts = 0;
if (config.preAbort) controller.abort();
const poll = setInterval(() => {
  try {
    Deno.statSync(`${config.root}/ready.json`);
    controller.abort();
  } catch { /* Wait for the synthetic boundary, not elapsed guesswork. */ }
}, 10);
const started = performance.now();
let rejected = false;
let error = "";
try {
  if (config.supervisor) {
    await supervise(
      new Deno.Command(config.python, {
        args: ["-B", config.script],
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }),
      new Uint8Array(config.inputBytes),
      undefined,
      1000,
      150,
    );
  } else {
    const { model } = await import(config.model);
    await model.methods[config.method].execute(config.args, {
      signal: controller.signal,
      globalArgs: { pythonPath: config.python, privateRoot: config.root },
      extensionFile: (path: string) =>
        `${config.runtime}/${path.split("/").pop()}`,
      logger: { info: (_message: string) => {} },
      writeResource: () => {
        receipts++;
        if (config.cancelAtReceipt) controller.abort();
        return Promise.resolve("test-handle");
      },
    });
  }
} catch (cause) {
  rejected = true;
  error = String(cause);
} finally {
  clearInterval(poll);
}
console.log(
  JSON.stringify({
    rejected,
    receipts,
    error,
    elapsedMs: performance.now() - started,
  }),
);
