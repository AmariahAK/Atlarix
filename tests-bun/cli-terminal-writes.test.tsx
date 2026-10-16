/**
 * Three bugs found recording the launch video (2026-10-05): the tab title
 * written into the middle of a colour code, the approval diff all one colour,
 * and "Build it" wrapping at ~72 columns.
 */
import { describe, expect, it } from "bun:test";
import { termWrite } from "../src/cli/tui/App";
import { clipCommand, splitDiffLine } from "../src/cli/tui/Approval";
import { planHint } from "../src/cli/tui/PlanPanel";

describe("writes the renderer does not draw", () => {
  it("go through the renderer's own writer, never straight to stdout", () => {
    const got: string[] = [];
    const renderer = { writeOut: (s: string) => void got.push(s) };
    const real = process.stdout.write;
    let direct = 0;
    process.stdout.write = (() => {
      direct++;
      return true;
    }) as typeof process.stdout.write;
    try {
      termWrite(renderer, "\x1b]0;◆ title\x07");
    } finally {
      process.stdout.write = real;
    }
    expect(got).toEqual(["\x1b]0;◆ title\x07"]);
    expect(direct).toBe(0);
  });
});

describe("the approval dialog's diff", () => {
  it("separates the line number and sign from the code it highlights", () => {
    expect(splitDiffLine({ kind: "add", text: "  12 + const a = 1;" })).toEqual({ prefix: "  12 + ", code: "const a = 1;" });
    expect(splitDiffLine({ kind: "context", text: "   3   return a;" })).toEqual({ prefix: "   3   ", code: "return a;" });
    expect(splitDiffLine({ kind: "remove", text: "-old line" })).toEqual({ prefix: "-", code: "old line" });
    expect(splitDiffLine({ kind: "gap", text: "⋯" })).toEqual({ prefix: "⋯", code: "" });
  });
});

describe("the approval dialog's command", () => {
  it("shows a long command's first rows and says how many lines are left, so the choices stay on screen", () => {
    const body = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    const got = clipCommand(`$ gh pr create --body-file - <<'EOF'\n${body}`, 80, 10);
    expect(got.text.split("\n")).toHaveLength(10);
    expect(got.text.split("\n")[0]).toBe("$ gh pr create --body-file - <<'EOF'");
    expect(got.more).toBe(51);
  });

  it("counts a wrapped line as the rows it takes", () => {
    const got = clipCommand(`${"a".repeat(150)}\nsecond\nthird`, 50, 4);
    expect(got).toEqual({ text: `${"a".repeat(150)}\nsecond`, more: 1 });
  });

  it("cuts one line longer than the whole space instead of showing nothing", () => {
    const got = clipCommand(`${"x".repeat(1000)}\nnext`, 40, 3);
    expect(got.text).toBe(`${"x".repeat(119)}…`);
    expect(got.more).toBe(1);
  });

  it("leaves a short command whole", () => {
    expect(clipCommand("$ ls -la", 80, 10)).toEqual({ text: "$ ls -la", more: 0 });
  });
});

describe("the plan panel's hint", () => {
  it("shrinks so Build it never wraps", () => {
    expect(planHint(120)).toContain("type below to change it");
    expect(planHint(72)).not.toContain("type below");
    expect(planHint(72).length).toBeLessThanOrEqual(72 - 16);
    expect(planHint(30)).toBe("  esc hide");
  });
});
