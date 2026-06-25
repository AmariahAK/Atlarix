/**
 * P1 — code copied from the editor is recognized as a CODE selection (not a
 * terminal paste), and the terminal heuristic no longer misfires on code.
 */
import { describe, expect, it } from "vitest";
import {
  ATLARIX_CODE_CLIPBOARD_MIME,
  parseCodeFromClipboard,
  writeCodeToDataTransfer,
} from "@/lib/chat/code-clipboard";
import { isCodeSelectionAttachment } from "@/lib/chat/code-selection-attachment";
import { looksLikeTerminalTranscript } from "@/lib/chat/terminal-line-buffer";

/** Minimal DataTransfer stub exposing only getData. */
function clip(data: Record<string, string>): DataTransfer {
  return { getData: (t: string) => data[t] ?? "" } as unknown as DataTransfer;
}

/** Read/write DataTransfer stub — mirrors a live copy event's clipboardData. */
function rwClip(): DataTransfer {
  const store: Record<string, string> = {};
  return {
    setData: (t: string, d: string) => {
      store[t] = d;
    },
    getData: (t: string) => store[t] ?? "",
  } as unknown as DataTransfer;
}

describe("parseCodeFromClipboard (P1)", () => {
  it("builds a codeSelection attachment from the code MIME", () => {
    const payload = {
      relpath: "src/models/user.py",
      lineStart: 110,
      lineEnd: 137,
      content: "def get_user(id):\n    return db.find(id)",
    };
    const att = parseCodeFromClipboard(
      clip({ [ATLARIX_CODE_CLIPBOARD_MIME]: JSON.stringify(payload) }),
    );
    expect(att).not.toBeNull();
    expect(isCodeSelectionAttachment(att!)).toBe(true);
    expect(att!.codeSelection!.relpath).toBe("src/models/user.py");
    expect(att!.codeSelection!.lineStart).toBe(110);
  });

  it("returns null without the code MIME (falls through to other handlers)", () => {
    expect(parseCodeFromClipboard(clip({ "text/plain": "hello" }))).toBeNull();
    expect(
      parseCodeFromClipboard(clip({ [ATLARIX_CODE_CLIPBOARD_MIME]: "not json" })),
    ).toBeNull();
  });

  // The regression that broke the code chip: the write side used the async
  // Clipboard API, whose custom MIME never reached the paste-event getData. This
  // asserts the synchronous setData write survives the round-trip end to end.
  it("round-trips via writeCodeToDataTransfer -> parseCodeFromClipboard", () => {
    const dt = rwClip();
    writeCodeToDataTransfer(dt, {
      relpath: "src/App.tsx",
      lineStart: 110,
      lineEnd: 125,
      content: "const x = 1;",
    });
    // text/plain is set too, so an ordinary paste elsewhere still yields code.
    expect(dt.getData("text/plain")).toBe("const x = 1;");

    const att = parseCodeFromClipboard(dt);
    expect(att).not.toBeNull();
    expect(isCodeSelectionAttachment(att!)).toBe(true);
    expect(att!.codeSelection!.relpath).toBe("src/App.tsx");
    expect(att!.codeSelection!.lineStart).toBe(110);
    expect(att!.codeSelection!.lineEnd).toBe(125);
    expect(att!.codeSelection!.content).toBe("const x = 1;");
  });
});

describe("looksLikeTerminalTranscript no longer misfires on code (P1)", () => {
  it("does NOT flag code/docs that merely contain a `$ ` command line", () => {
    const codeWithShellExample = [
      "// To install:",
      "// $ npm install foo",
      "export const x = 1;",
      "const cmd = `> ${name}`;",
    ].join("\n");
    expect(looksLikeTerminalTranscript(codeWithShellExample)).toBe(false);
  });

  it("still flags a real transcript with [You]/[Agent] owner prefixes", () => {
    const transcript = "[You] $ ls -la\n[You] total 8\n[Agent] $ npm test";
    expect(looksLikeTerminalTranscript(transcript)).toBe(true);
  });
});
