import { describe, expect, it } from "vitest";
import { formatToolResultDisplay } from "@/lib/chat/format-tool-result";
import type { AssistantMessagePart } from "@/lib/chat/assistant-message-parts";

function toolPart(
  overrides: Partial<Extract<AssistantMessagePart, { type: "tool" }>> &
    Pick<
      Extract<AssistantMessagePart, { type: "tool" }>,
      "toolName" | "resultText"
    >,
): Extract<AssistantMessagePart, { type: "tool" }> {
  return {
    type: "tool",
    id: "t1",
    status: "success",
    ...overrides,
  };
}

describe("formatToolResultDisplay", () => {
  it("uses repo_overview bodyKind for get_repo_overview markdown", () => {
    const inner = "# Repo overview: Atlarix\n\n## Top-level structure\n- src/";
    const formatted = formatToolResultDisplay(
      toolPart({
        toolName: "get_repo_overview",
        resultText: JSON.stringify({ success: true, result: inner }),
      }),
    );
    expect(formatted.bodyKind).toBe("repo_overview");
    expect(formatted.summary).toContain("Repo overview");
    expect(formatted.body).toContain("## Top-level");
  });

  it("unwraps nested result.result strings", () => {
    const formatted = formatToolResultDisplay(
      toolPart({
        toolName: "read_file",
        resultText: JSON.stringify({
          success: true,
          result: { success: true, result: "file contents here" },
        }),
      }),
    );
    expect(formatted.body).toBe("file contents here");
  });

  it("collapses long read_file bodies for preview", () => {
    const long = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");
    const formatted = formatToolResultDisplay(
      toolPart({
        toolName: "read_file",
        resultText: JSON.stringify({ success: true, result: long }),
      }),
    );
    expect(formatted.body.split("\n").length).toBeLessThanOrEqual(49);
    expect(formatted.body).toContain("…");
  });
});
