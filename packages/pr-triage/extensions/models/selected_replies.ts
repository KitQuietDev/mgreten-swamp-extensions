/** Validate the complete selection before allowing any GitHub reply writes. */
import { z } from "npm:zod@4";

const Reply = z.object({
  rootId: z.number().int().positive(),
  body: z.string().trim().min(1).max(16_000),
}).strict();

export async function postSelectedReplies(input: unknown, deps: {
  eligibleRoots: ReadonlySet<number>;
  post: (reply: z.infer<typeof Reply>) => Promise<void>;
}) {
  const selected = z.array(Reply).min(1).max(50).parse(input);
  const ids = new Set<number>();
  for (const { rootId } of selected) {
    if (ids.has(rootId) || !deps.eligibleRoots.has(rootId)) {
      throw new Error(`Unknown or duplicate review thread ${rootId}`);
    }
    ids.add(rootId);
  }
  const posted: number[] = [];
  for (const reply of selected) {
    try {
      await deps.post(reply);
    } catch (cause) {
      throw new Error(
        `Stopped at thread ${reply.rootId}; confirmed posted: ${
          posted.join(", ") || "none"
        }. Check GitHub before retrying.`,
        { cause },
      );
    }
    posted.push(reply.rootId);
  }
  return posted;
}
