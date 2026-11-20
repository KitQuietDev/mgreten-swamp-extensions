import { assertEquals, assertRejects } from "@std/assert";
import { pendingReview, reviewDraftId } from "./review_draft.ts";

Deno.test("stages exactly the displayed review and rejects changed text, target or head", async () => {
  const draft = {
    repo: "octo-org/widgets",
    prNumber: 19,
    headSha: "a".repeat(40),
    body: "Please preserve the previous API response on retries.",
  };
  const id = await reviewDraftId(draft);
  assertEquals(await pendingReview(draft, id, draft.headSha), {
    commit_id: draft.headSha,
    body: draft.body,
  });
  for (
    const changed of [
      { ...draft, body: "Looks good." },
      { ...draft, prNumber: 20 },
      { ...draft, repo: "octo-org/other" },
    ]
  ) {
    await assertRejects(
      () => pendingReview(changed, id, draft.headSha),
      Error,
      "Review draft changed",
    );
  }
  await assertRejects(
    () => pendingReview(draft, id, "b".repeat(40)),
    Error,
    "PR changed",
  );
});
