import { describe, expect, it } from "vitest";
import { upsertActivityStreamItem } from "@/lib/chat-activity-normalize";
import type { ActivityStreamItem } from "@/atoms/sourceAtoms";

function toolRow(id: string, status: ActivityStreamItem["status"]): ActivityStreamItem {
  return {
    id,
    type: "tool_use",
    label: "Reading files…",
    status,
    timestamp: 1,
    chatId: -1,
  };
}

describe("upsertActivityStreamItem", () => {
  it("replaces an existing row by id instead of appending", () => {
    const prev = [toolRow("tool-read_file-1", "running")];
    const next = upsertActivityStreamItem(prev, toolRow("tool-read_file-1", "done"));
    expect(next).toHaveLength(1);
    expect(next[0]?.status).toBe("done");
  });

  it("appends when id is new", () => {
    const prev = [toolRow("a", "done")];
    const next = upsertActivityStreamItem(prev, toolRow("b", "running"));
    expect(next).toHaveLength(2);
  });
});
