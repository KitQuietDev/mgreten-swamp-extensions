/** Write the most recent board snapshot and its HTML report. @module */
import { BoardSchema } from "../models/board_schema.ts";
import { expandPath, Settings } from "../models/pr_triage.ts";
import { renderDashboardHtml } from "./dashboard.ts";

type Context = {
  modelType: string;
  modelId: string;
  globalArgs: Record<string, unknown>;
  dataHandles?: Array<{ specName: string; name: string; version: number }>;
  dataRepository: {
    getContent(
      type: string,
      id: string,
      name: string,
      version: number,
    ): Promise<Uint8Array | null>;
  };
};

/** Method report for the scanner. */
export const report = {
  name: "@mgreten/pr-triage-dashboard",
  description:
    "Write board.json and a self-contained dashboard.html for the latest scan",
  scope: "method" as const,
  labels: ["github", "dashboard"],
  execute: async (
    context: Context,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    const handle = context.dataHandles?.find((handle) =>
      handle.specName === "board"
    );
    if (!handle) {
      return {
        markdown: "No board written by this run.",
        json: { written: false },
      };
    }
    const bytes = await context.dataRepository.getContent(
      context.modelType,
      context.modelId,
      handle.name,
      handle.version,
    );
    if (!bytes) throw new Error(`Missing content for ${handle.name}`);
    const board = BoardSchema.parse(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
    const settings = Settings.parse(context.globalArgs);
    const dir = expandPath(settings.outputDir);
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/dashboard.html`,
      renderDashboardHtml(board, Date.now(), settings.theme),
    );
    // The polling server must see either the old complete snapshot or the new one.
    const temp = await Deno.makeTempFile({ dir, prefix: ".board-" });
    try {
      await Deno.writeTextFile(temp, JSON.stringify(board));
      await Deno.rename(temp, `${dir}/board.json`);
    } catch (error) {
      await Deno.remove(temp).catch((cleanupError) => {
        console.error(
          "Could not remove incomplete board snapshot",
          cleanupError,
        );
      });
      throw error;
    }
    return {
      markdown:
        `# PR & CI Triage\n\n${board.summary.total} open PRs. Snapshot: \`${dir}/board.json\`.`,
      json: { written: true, ...board.summary },
    };
  },
};
