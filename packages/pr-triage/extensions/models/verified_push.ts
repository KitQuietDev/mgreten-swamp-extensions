/** Verify a reviewed candidate in a disposable checkout, then push its exact SHA. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await new Deno.Command("git", {
    cwd,
    args,
    signal: AbortSignal.timeout(60_000),
  }).output();
  if (!result.success) throw new Error(`Git ${args[0]} failed`);
  return new TextDecoder().decode(result.stdout);
}

export async function verifyAndPush(input: {
  checkout: string;
  remote: string;
  branch: string;
  base: string;
  candidate: string;
  verify: (checkout: string, candidate: string) => Promise<void>;
}) {
  const { checkout, remote, branch, base, candidate, verify } = input;
  if (
    ![base, candidate].every((value) => /^[a-f0-9]{40}$/.test(value)) ||
    base === candidate
  ) {
    throw new Error("Expected distinct full commit hashes");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(remote)) {
    throw new Error("Expected a named remote");
  }
  const ref = `refs/heads/${branch}`;
  await git(checkout, "check-ref-format", ref);
  if (
    (await git(checkout, "rev-parse", `${candidate}^`)).trim() !== base ||
    (await git(checkout, "rev-list", "--parents", "-n1", candidate)).trim()
        .split(" ").length !== 2
  ) {
    throw new Error("Candidate must be one commit on top of the reviewed head");
  }
  const current = async () =>
    (await git(checkout, "ls-remote", "--refs", remote, ref)).trim().split(
      "\t",
    )[0];
  if (await current() !== base) {
    throw new Error("Branch changed; prepare the fix again");
  }
  const dir = await Deno.makeTempDir({ prefix: "pr-triage-verify-" });
  try {
    await git(
      checkout,
      "worktree",
      "add",
      "--detach",
      `${dir}/check`,
      candidate,
    );
    try {
      await verify(`${dir}/check`, candidate);
    } finally {
      await git(checkout, "worktree", "remove", "--force", `${dir}/check`);
    }
    if (await current() !== base) {
      throw new Error("Branch changed during verification");
    }
    await git(checkout, "push", remote, `${candidate}:${ref}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}
