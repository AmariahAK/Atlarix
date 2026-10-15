import { describe, expect, it } from "vitest";
import { searchPreviewText } from "@/lib/chat/search-preview";

describe("a chat search preview", () => {
  it("shows the words, not the stored tool markup", () => {
    const stored =
      'Updated your defaults.\n<atlarix-tool-call tool="mcp_servers" call="call_6r6w" status="running">\n{"operation":"defaults"}\n</atlarix-tool-call>\nDone: Linear removed.';
    expect(searchPreviewText(stored)).toBe(
      "Updated your defaults. Done: Linear removed.",
    );
  });

  it("drops thinking and a tag cut off at the end", () => {
    expect(
      searchPreviewText('<think>plan</think>Sure. <atlarix-tool-call tool="x"'),
    ).toBe("Sure.");
  });
});
