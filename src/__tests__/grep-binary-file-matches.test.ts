/**
 * grep reports a file it cannot print, instead of silently skipping it.
 *
 * A file holding a NUL byte is "binary" to ripgrep. In a RECURSIVE search — which
 * is how this tool always searches — ripgrep skips such files and says nothing at
 * all; the `binary file matches` notice is only printed for files named
 * explicitly on the command line. So the tool needs `--binary` to make the notice
 * exist, and `parseGrepOutput` needs to recognise it once it does.
 *
 * Both halves were missing, and the cost was real: FOUR source files in this repo
 * carried a literal NUL as a string separator (written as a raw byte rather than
 * the escape `\u0000`) and were therefore unsearchable —
 * `src/lib/tools/web.ts`, `src/atoms/sessionAtoms.ts`, `src/hooks/useAttachments.ts`
 * and `src/lib/streaming/agentic-loop-repetition.ts`. grep answered "No matches"
 * for every symbol in all four.
 *
 * That is the same failure the Windows drive-letter bug produced (see
 * grep-windows-drive-letter.test.ts): a silent wrong answer, which tells the model
 * the code it is looking for does not exist.
 */
import { describe, it, expect } from "vitest";
import { parseGrepOutput } from "@/lib/tools/grep";

/** Verbatim ripgrep 15.x output shape, captured from a real `--binary` run. */
const NOTICE = (p: string) =>
  `${p}: binary file matches (found "\\0" byte around offset 11714)`;

describe("parseGrepOutput and ripgrep's binary-file notice", () => {
  it("keeps the file as a group flagged binary, with no matches", () => {
    const groups = parseGrepOutput(NOTICE("/repo/src/lib/tools/web.ts") + "\n");
    expect(groups).toHaveLength(1);
    expect(groups[0].file).toBe("/repo/src/lib/tools/web.ts");
    expect(groups[0].binary).toBe(true);
    expect(groups[0].matches).toEqual([]);
  });

  it("absorbs a Windows drive letter, like the match parser does", () => {
    const groups = parseGrepOutput(NOTICE("C:\\repo\\src\\web.ts"));
    expect(groups).toHaveLength(1);
    expect(groups[0].file).toBe("C:\\repo\\src\\web.ts");
    expect(groups[0].binary).toBe(true);
  });

  it("interleaves with ordinary matches without disturbing their grouping", () => {
    // ripgrep emits one block per file; the notice is its own block.
    const out = [
      "/repo/a.ts:1:first",
      "/repo/a.ts:9:second",
      NOTICE("/repo/blob.ts"),
      "/repo/b.ts:2:third",
    ].join("\n");
    const groups = parseGrepOutput(out);
    expect(groups.map((g) => g.file)).toEqual([
      "/repo/a.ts",
      "/repo/blob.ts",
      "/repo/b.ts",
    ]);
    expect(groups[0].matches).toHaveLength(2);
    expect(groups[0].binary).toBeUndefined();
    expect(groups[1].binary).toBe(true);
    expect(groups[2].matches).toHaveLength(1);
  });

  it("does NOT mistake matched content that mentions the phrase for a notice", () => {
    // A source line can say anything, including this. Only `<path>: <phrase>`
    // with no line number is the notice; `<path>:<line>:<text>` is a match.
    const out = "/repo/a.ts:3:// binary file matches (a comment about ripgrep)";
    const groups = parseGrepOutput(out);
    expect(groups).toHaveLength(1);
    expect(groups[0].binary).toBeUndefined();
    expect(groups[0].matches[0].line).toBe(3);
    expect(groups[0].matches[0].content).toBe(
      "// binary file matches (a comment about ripgrep)",
    );
  });

  it("the notice cannot satisfy the match regex — which is why it was dropped", () => {
    // Pins the ROOT CAUSE, not just the fix: the notice carries no `:<digits>:`,
    // so the pre-fix parser hit `if (!m) continue` and lost the file entirely.
    const matchRe = /^((?:[A-Za-z]:)?[^:]*):(\d+):([\s\S]*)$/;
    expect(matchRe.test(NOTICE("/repo/blob.ts"))).toBe(false);
  });
});
