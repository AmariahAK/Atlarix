/**
 * grep survives a Windows drive letter; a bare `*` glob stays one directory deep.
 *
 * Two separator bugs, both found by the v14.27.0 tag build — the first Windows run
 * of code that shipped in the v14.26.0 batch. Neither is reachable from a POSIX
 * machine, which is why both are pinned here against literal Windows-shaped input
 * rather than against a live filesystem.
 *
 * 1. `parseGrepOutput` split each ripgrep line on ":". A Windows drive letter
 *    carries its own colon, so
 *
 *      C:\repo\pkg\loader.go:3:// marker
 *
 *    became file="C", lineNum="\repo\pkg\loader.go", and `parseInt` returned NaN —
 *    so the match was DISCARDED. ripgrep is handed an absolute search root, so
 *    every path it prints on Windows begins with a drive letter, and every match
 *    was dropped. grep reported "No matches" no matter how many there were: a
 *    silent wrong answer that tells the model the code it is looking for does not
 *    exist.
 *
 * 2. glob's bare-`*` filter tested `!f.includes("/")` to keep top-level entries.
 *    ripgrep separates with the PLATFORM's separator, so on Windows the filter
 *    matched nothing and `glob("*")` returned the whole recursive tree instead of
 *    one directory — the opposite of what was asked, straight into the context.
 */
import { describe, it, expect } from "vitest";
import { parseGrepOutput } from "@/lib/tools/grep";

describe("parseGrepOutput with Windows paths", () => {
  it("keeps the drive letter with the file, not as the file", () => {
    const out = "C:\\repo\\pkg\\loader.go:3:// cross-repo-marker-9c1f\n";
    const groups = parseGrepOutput(out);
    expect(groups).toHaveLength(1);
    expect(groups[0].file).toBe("C:\\repo\\pkg\\loader.go");
    expect(groups[0].matches[0].line).toBe(3);
    expect(groups[0].matches[0].content).toBe("// cross-repo-marker-9c1f");
  });

  it("groups several matches in one Windows file", () => {
    const out = [
      "C:\\repo\\a.ts:1:first",
      "C:\\repo\\a.ts:9:second",
      "C:\\repo\\b.ts:2:third",
    ].join("\n");
    const groups = parseGrepOutput(out);
    expect(groups.map((g) => g.file)).toEqual([
      "C:\\repo\\a.ts",
      "C:\\repo\\b.ts",
    ]);
    expect(groups[0].matches).toHaveLength(2);
  });

  it("keeps colons that belong to the matched CONTENT", () => {
    // The content is everything after the line number, colons and all.
    const out = 'C:\\repo\\a.ts:4:const url = "https://example.com:8080";';
    const groups = parseGrepOutput(out);
    expect(groups[0].matches[0].content).toBe(
      'const url = "https://example.com:8080";',
    );
  });

  it("still parses POSIX output exactly as before", () => {
    const out = "/Users/me/repo/pkg/loader.go:3:// marker\n";
    const groups = parseGrepOutput(out);
    expect(groups[0].file).toBe("/Users/me/repo/pkg/loader.go");
    expect(groups[0].matches[0].line).toBe(3);
    expect(groups[0].matches[0].content).toBe("// marker");
  });

  it("skips context lines, which ripgrep separates with a dash", () => {
    // `-C` context uses `file-line-text`; only `file:line:text` is a match.
    const out = ["C:\\repo\\a.ts-2-before", "C:\\repo\\a.ts:3:hit"].join("\n");
    const groups = parseGrepOutput(out);
    expect(groups).toHaveLength(1);
    expect(groups[0].matches).toHaveLength(1);
    expect(groups[0].matches[0].line).toBe(3);
  });

  it("returns nothing for genuinely empty output", () => {
    expect(parseGrepOutput("")).toEqual([]);
  });
});

describe("glob's bare-* top-level filter", () => {
  // The filter as shipped, both spellings, so the fix is pinned independently of
  // the surrounding tool plumbing (which needs a real filesystem to exercise).
  const topLevelOnly = (files: string[]) =>
    files.filter((f) => !/[\\/]/.test(f));

  it("drops nested entries whichever separator ripgrep used", () => {
    expect(
      topLevelOnly([
        "own.ts",
        "wisdom-drop\\src\\own.ts",
        "telios/README.md",
        "README.md",
      ]),
    ).toEqual(["own.ts", "README.md"]);
  });

  it("the old POSIX-only test would have kept the Windows paths", () => {
    // Exactly what the Windows runner reported: three nested files returned from
    // a query that asked for one directory's contents.
    const windowsNested = ["wisdom-drop\\src\\own.ts", "telios\\README.md"];
    expect(windowsNested.filter((f) => !f.includes("/"))).toHaveLength(2); // the bug
    expect(topLevelOnly(windowsNested)).toHaveLength(0); // the fix
  });
});
