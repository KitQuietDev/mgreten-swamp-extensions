import { assertEquals, assertRejects } from "@std/assert";
import { git, verifyAndPush } from "./verified_push.ts";

Deno.test("a local remote moves only after the exact candidate passes verification", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await git(dir, "init", "--bare", "remote.git");
    await git(dir, "init", "-b", "feature", "checkout");
    const checkout = `${dir}/checkout`;
    await git(checkout, "config", "user.email", "test@example.com");
    await git(checkout, "config", "user.name", "Fixture");
    await git(checkout, "remote", "add", "origin", `${dir}/remote.git`);
    await git(checkout, "commit", "--allow-empty", "-m", "base");
    await git(checkout, "push", "origin", "feature");
    const base = (await git(checkout, "rev-parse", "HEAD")).trim();
    await Deno.writeTextFile(`${checkout}/sample.txt`, "expected\n");
    await git(checkout, "add", "sample.txt");
    await git(checkout, "commit", "-m", "candidate");
    const candidate = (await git(checkout, "rev-parse", "HEAD")).trim();
    const input = {
      checkout,
      remote: "origin",
      branch: "feature",
      base,
      candidate,
    };
    const remoteHead = async () =>
      (await git(`${dir}/remote.git`, "rev-parse", "feature")).trim();
    await assertRejects(
      () =>
        verifyAndPush({
          ...input,
          verify: () => Promise.reject(new Error("check failed")),
        }),
      Error,
      "check failed",
    );
    assertEquals(await remoteHead(), base);
    await verifyAndPush({
      ...input,
      verify: async (cwd, expected) => {
        assertEquals((await git(cwd, "rev-parse", "HEAD")).trim(), expected);
        assertEquals(
          await Deno.readTextFile(`${cwd}/sample.txt`),
          "expected\n",
        );
        assertEquals(await remoteHead(), base);
      },
    });
    assertEquals(await remoteHead(), candidate);
    await assertRejects(
      () => verifyAndPush({ ...input, verify: () => Promise.resolve() }),
      Error,
      "Branch changed",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
