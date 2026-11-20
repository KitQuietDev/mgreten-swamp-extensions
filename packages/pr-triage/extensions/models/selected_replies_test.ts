import { assertEquals, assertRejects } from "@std/assert";
import { postSelectedReplies } from "./selected_replies.ts";

Deno.test("checks all selected roots before posting and preserves the edited reply text", async () => {
  const calls: Array<{ rootId: number; body: string }> = [];
  const deps = {
    eligibleRoots: new Set([13, 29]),
    post: async (reply: { rootId: number; body: string }) => {
      calls.push(reply);
    },
  };
  const first = { rootId: 29, body: "Changed this to preserve ordering." };
  const second = { rootId: 13, body: "Leaving this as-is for compatibility." };
  await assertRejects(
    () => postSelectedReplies([first, { ...second, rootId: 55 }], deps),
    Error,
    "Unknown or duplicate",
  );
  await assertRejects(
    () => postSelectedReplies([first, first], deps),
    Error,
    "Unknown or duplicate",
  );
  assertEquals(calls, []);
  assertEquals(await postSelectedReplies([first, second], deps), [29, 13]);
  assertEquals(calls, [first, second]);
});
