import { describe, expect, it } from "vitest";
import type { TerminalLine } from "@/atoms/terminalInstancesAtoms";
import {
  buildTerminalPasteAttachment,
  capTerminalLines,
  commandBlockRangeAt,
  lastCommandBlockRange,
  looksLikeTerminalTranscript,
  TERMINAL_MAX_LINES,
} from "@/lib/chat/terminal-line-buffer";

function line(
  i: number,
  kind: TerminalLine["kind"],
  text: string,
): TerminalLine {
  return {
    id: `l-${i}`,
    prefix: "[You]",
    text,
    kind,
  };
}

describe("terminal-line-buffer", () => {
  it("capTerminalLines keeps the last N lines", () => {
    const lines = Array.from({ length: TERMINAL_MAX_LINES + 50 }, (_, i) =>
      line(i, "output", `line-${i}`),
    );
    const capped = capTerminalLines(lines);
    expect(capped).toHaveLength(TERMINAL_MAX_LINES);
    expect(capped[0]!.text).toBe(`line-50`);
    expect(capped[capped.length - 1]!.text).toBe(
      `line-${TERMINAL_MAX_LINES + 49}`,
    );
  });

  it("lastCommandBlockRange returns prompt through status before next prompt", () => {
    const lines: TerminalLine[] = [
      line(0, "prompt", "$ ls"),
      line(1, "output", "a"),
      line(2, "status", "exit 0"),
      line(3, "prompt", "$ git status"),
      line(4, "output", "clean"),
      line(5, "status", "exit 0"),
    ];
    const block = lastCommandBlockRange(lines);
    expect(block).not.toBeNull();
    expect(block!.start).toBe(4);
    expect(block!.end).toBe(6);
    expect(block!.slice).toHaveLength(3);
  });

  it("commandBlockRangeAt stops at next prompt", () => {
    const lines: TerminalLine[] = [
      line(0, "prompt", "$ one"),
      line(1, "output", "out"),
      line(2, "prompt", "$ two"),
    ];
    const { start, end, slice } = commandBlockRangeAt(lines, 0);
    expect(start).toBe(1);
    expect(end).toBe(2);
    expect(slice).toHaveLength(2);
  });

  it("looksLikeTerminalTranscript only matches Atlarix [You]/[Agent] prefixes (P1)", () => {
    expect(looksLikeTerminalTranscript("[You] $ ls\n[You] a")).toBe(true);
    expect(looksLikeTerminalTranscript("[Agent] $ npm test\n[Agent] ok")).toBe(true);
    // P1: a bare `$ ` line (no owner prefix) is NOT treated as a terminal
    // transcript — it appears constantly in code/docs and was misclassifying
    // pasted code. Real Atlarix terminal copies use the custom clipboard MIME.
    expect(looksLikeTerminalTranscript("$ npm test\nok")).toBe(false);
    expect(looksLikeTerminalTranscript("hello")).toBe(false);
    expect(looksLikeTerminalTranscript("")).toBe(false);
  });

  it("buildTerminalPasteAttachment uses command label and split content", () => {
    const att = buildTerminalPasteAttachment({
      lines: [
        { id: "a", prefix: "[You]", text: "$ ls", kind: "prompt" },
        { id: "b", prefix: "[You]", text: "file.txt", kind: "output" },
      ],
      instanceLabel: "Shell 1",
      owner: "user",
      lineStart: 1,
      lineEnd: 2,
    });
    expect(att.terminalPaste?.displayName).toBe("ls (1-2)");
    expect(att.terminalPaste?.content).toBe("[You] $ ls\nfile.txt");
    expect(att.terminalPaste?.displayContent).toBe("[You] $ ls\nfile.txt");
    expect(att.terminalPaste?.displayContent).not.toContain("[You] file");
  });
});
