/**
 * readClipboardPlainText — resilience to the clipboard SOURCE app. Rich-text
 * sources (Notes/TextEdit) may populate only text/html; we fall back to it and
 * strip to plain text so the paste still becomes an attachment. (jsdom env for
 * DOMParser.)
 */
import { describe, expect, it } from "vitest";
import { readClipboardPlainText } from "@/lib/chat/text-paste-attachment";

function clip(data: Record<string, string>): DataTransfer {
  return {
    getData: (type: string) => data[type] ?? "",
  } as unknown as DataTransfer;
}

describe("readClipboardPlainText", () => {
  it("returns text/plain when present (code-editor sources like Cursor)", () => {
    expect(readClipboardPlainText(clip({ "text/plain": "hello world" }))).toBe(
      "hello world",
    );
  });

  it("falls back to text/html (stripped) when text/plain is empty (rich-text sources)", () => {
    const html = "<p>Line one</p><p>Line two</p>";
    expect(
      readClipboardPlainText(clip({ "text/plain": "", "text/html": html })),
    ).toBe("Line oneLine two");
  });

  it("prefers text/plain over html when plain has content", () => {
    expect(
      readClipboardPlainText(
        clip({ "text/plain": "plain wins", "text/html": "<b>html</b>" }),
      ),
    ).toBe("plain wins");
  });

  it("returns empty string when neither flavor has text", () => {
    expect(readClipboardPlainText(clip({}))).toBe("");
    expect(readClipboardPlainText(clip({ "text/plain": "   " }))).toBe("");
  });
});
