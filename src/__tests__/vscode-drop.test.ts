/**
 * A file dropped from the desktop into the VS Code panel (TODO 2026-11-03:
 * "drag and drop does not work"): images were the only desktop files taken.
 */
import { describe, expect, it } from "vitest";
import { DROPPED_TEXT_MAX_BYTES, droppedFileKind } from "../../packages/vscode/webview/chat/drop";

describe("a file dropped from the desktop", () => {
  it("an image stays an image", () => {
    expect(droppedFileKind({ type: "image/png", size: 10 })).toBe("image");
  });
  it("a text file comes in as its text (it used to vanish)", () => {
    expect(droppedFileKind({ type: "text/plain", size: 120 }, new TextEncoder().encode("hello"))).toBe("text");
    expect(droppedFileKind({ type: "", size: 120 }, new TextEncoder().encode("export const a = 1;"))).toBe("text");
  });
  it("a binary or too-big file is named, not attached", () => {
    expect(droppedFileKind({ type: "application/octet-stream", size: 10 }, new Uint8Array([1, 0, 2]))).toBe("binary");
    expect(droppedFileKind({ type: "text/plain", size: DROPPED_TEXT_MAX_BYTES + 1 })).toBe("too-big");
  });
});
