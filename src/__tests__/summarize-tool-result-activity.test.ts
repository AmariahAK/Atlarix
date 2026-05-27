import { describe, expect, it } from "vitest";
import { summarizeToolResultForActivityDetail } from "@/lib/chat/stream-tool-display";

describe("summarizeToolResultForActivityDetail", () => {
  it("returns explore_folder item summary", () => {
    const result = JSON.stringify({
      success: true,
      result: {
        total: 120,
        items: [
          { path: "src/gchat/server.ts", type: "file" },
          { path: "src/gchat/agentLoop.ts", type: "file" },
        ],
      },
    });
    const detail = summarizeToolResultForActivityDetail("explore_folder", result, "done");
    expect(detail).toMatch(/120 items/);
    expect(detail).toContain("src/gchat/server.ts");
  });

  it("returns search match summary with paths", () => {
    const result = JSON.stringify({
      success: true,
      matches: [{ path: "a.ts" }, { path: "b.ts" }, { path: "a.ts" }],
    });
    const detail = summarizeToolResultForActivityDetail("search", result, "done");
    expect(detail).toMatch(/3 matches found/);
    expect(detail).toContain("a.ts");
  });

  it("reports lines written for write_file", () => {
    const result = JSON.stringify({
      success: true,
      result: "a\nb\nc",
    });
    const detail = summarizeToolResultForActivityDetail("write_file", result, "done");
    expect(detail).toBe("3 lines written");
  });
});
