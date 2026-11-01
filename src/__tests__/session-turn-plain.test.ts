import { describe, expect, it } from "vitest";
import { formatTurnPlain } from "@/lib/tools/sessions";

/**
 * QA (owner, 2026-10-31): session_search printed whole turns as raw JSON — the
 * `<atlarix-tool-call>` / `<atlarix-tool-result>` markup, JSON args, the
 * `"ui":{"groups":…}` envelope, other tools' full results. Read mode must return
 * what was said and which tools ran, never that markup.
 */
describe("formatTurnPlain", () => {
  it("keeps a user message as it was", () => {
    expect(formatTurnPlain("user", "deploy to staging\n")).toBe(
      "deploy to staging",
    );
  });

  it("shows an assistant's words and tool NAMES, not the raw markup", () => {
    const raw = [
      "I'll look at the file.",
      '<atlarix-tool-call tool="read_file">{ "path": "/a.ts" }</atlarix-tool-call>',
      '<atlarix-tool-result tool="read_file">{ "success": true, "result": { "result": "const a = 1" } }</atlarix-tool-result>',
      "The file defines `a`.",
    ].join("\n");
    const out = formatTurnPlain("assistant", raw);
    expect(out).toContain("I'll look at the file.");
    expect(out).toContain("[read_file]");
    expect(out).toContain("The file defines `a`.");
    expect(out).not.toContain("<atlarix-tool-call");
    expect(out).not.toContain("<atlarix-tool-result");
    expect(out).not.toContain('"ui"');
  });

  it("returns the raw text when the assistant content cannot be parsed", () => {
    expect(formatTurnPlain("assistant", "plain prose")).toBe("plain prose");
  });
});
