import { describe, expect, it } from "vitest";
import {
  extractAtlarixChatSummary,
  isDefaultSessionTitle,
} from "@/lib/workspace-session-title";

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

describe("isDefaultSessionTitle", () => {
  it("recognizes default titles", () => {
    expect(isDefaultSessionTitle("Untitled")).toBe(true);
    expect(isDefaultSessionTitle("New session")).toBe(true);
  });

  it("rejects custom titles", () => {
    expect(isDefaultSessionTitle("Auth refactor plan")).toBe(false);
  });
});
