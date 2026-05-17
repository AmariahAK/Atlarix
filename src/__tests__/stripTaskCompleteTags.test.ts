import { describe, expect, it } from "vitest";
import { stripTaskCompleteTags } from "@/ipc/utils/thinking_tags";

describe("stripTaskCompleteTags", () => {
  it("removes full task_complete blocks", () => {
    const input = "Done.\n<task_complete>Task finished successfully</task_complete>";
    expect(stripTaskCompleteTags(input)).toBe("Done.");
  });

  it("removes orphan open/close tags", () => {
    const input = "Almost <task_complete> done </task_complete>";
    expect(stripTaskCompleteTags(input)).not.toContain("task_complete");
  });

  it("is case-insensitive", () => {
    const input = "All set. <TASK_COMPLETE>done</TASK_COMPLETE>";
    expect(stripTaskCompleteTags(input)).toBe("All set.");
  });

  it("preserves surrounding prose", () => {
    const input = "Summary here.\n\n<task_complete>done</task_complete>\n\nThanks.";
    expect(stripTaskCompleteTags(input)).toBe("Summary here.\n\nThanks.");
  });
});
