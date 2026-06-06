/**
 * v12 0.3: diagnostics → feedback formatting (errors-only filter, caps,
 * null on clean).
 */

import { describe, expect, it } from "vitest";
import type { Diagnostic } from "vscode-languageserver-types";
import { formatDiagnosticsFeedback } from "@/lib/agent/post-write-verify";

const diag = (line: number, message: string, severity = 1): Diagnostic => ({
  range: {
    start: { line, character: 0 },
    end: { line, character: 10 },
  },
  message,
  severity: severity as Diagnostic["severity"],
});

describe("formatDiagnosticsFeedback", () => {
  it("returns null when all files are clean", () => {
    expect(
      formatDiagnosticsFeedback([
        { file: "src/a.ts", diagnostics: [] },
        { file: "src/b.ts", diagnostics: [] },
      ]),
    ).toBeNull();
  });

  it("filters warnings — errors only", () => {
    const out = formatDiagnosticsFeedback([
      {
        file: "src/a.ts",
        diagnostics: [diag(4, "unused variable", 2), diag(9, "Type error", 1)],
      },
    ]);
    expect(out).toContain('<diagnostics file="src/a.ts">');
    expect(out).toContain("line 10: Type error"); // 0-based → 1-based
    expect(out).not.toContain("unused variable");
  });

  it("caps diagnostics per file at 10", () => {
    const many = Array.from({ length: 25 }, (_, i) => diag(i, `err ${i}`));
    const out = formatDiagnosticsFeedback([
      { file: "src/a.ts", diagnostics: many },
    ])!;
    expect(out.match(/- line /g)?.length).toBe(10);
  });

  it("keeps only the first line of multi-line messages", () => {
    const out = formatDiagnosticsFeedback([
      {
        file: "src/a.ts",
        diagnostics: [diag(0, "first line\nsecond line detail")],
      },
    ])!;
    expect(out).toContain("first line");
    expect(out).not.toContain("second line detail");
  });
});
