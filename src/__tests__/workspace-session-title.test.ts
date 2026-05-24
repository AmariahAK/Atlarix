import { describe, expect, it } from "vitest";
import { extractAtlarixChatSummary } from "@/lib/workspace-session-title";
import { titleFromFirstUserMessage } from "@/lib/session-title";

describe("extractAtlarixChatSummary", () => {
  it("extracts tag at start of reply", () => {
    const content =
      "<atlarix-chat-summary>CLI webhook flow</atlarix-chat-summary>\n\nHello there.";
    expect(extractAtlarixChatSummary(content)).toBe("CLI webhook flow");
  });

  it("extracts tag at end of reply", () => {
    const content =
      "Here is the answer.\n\n<atlarix-chat-summary>Rename profile file</atlarix-chat-summary>";
    expect(extractAtlarixChatSummary(content)).toBe("Rename profile file");
  });

  it("returns null when tag missing", () => {
    expect(extractAtlarixChatSummary("no tag here")).toBeNull();
  });
});

describe("titleFromFirstUserMessage (instant session title)", () => {
  it("uses first line of user message", () => {
    expect(titleFromFirstUserMessage("How does auth work?")).toBe(
      "How does auth work?",
    );
  });

  it("truncates long messages", () => {
    const long = "a".repeat(60);
    expect(titleFromFirstUserMessage(long)).toMatch(/…$/);
    expect(titleFromFirstUserMessage(long).length).toBeLessThanOrEqual(51);
  });

  it("returns Untitled for empty input", () => {
    expect(titleFromFirstUserMessage("   ")).toBe("Untitled");
  });
});
