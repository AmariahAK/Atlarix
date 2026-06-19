import { describe, expect, it } from "vitest";
import { extractPartialToolArgs } from "@/lib/chat/partial-tool-args";

describe("extractPartialToolArgs", () => {
  it("returns null for non-edit tools and empty input", () => {
    expect(extractPartialToolArgs("run_command", '{"command":"ls"}')).toBeNull();
    expect(extractPartialToolArgs("edit_file", "")).toBeNull();
  });

  it("extracts path before content has started", () => {
    const partial = '{"operation":"write","path":"src/app.ts","content":"';
    const out = extractPartialToolArgs("edit_file", partial);
    expect(out?.path).toBe("src/app.ts");
    expect(out?.operation).toBe("write");
  });

  it("extracts truncated content (no closing quote yet), unescaping newlines", () => {
    const partial = '{"operation":"write","path":"a.ts","content":"line1\\nline2\\nlin';
    const out = extractPartialToolArgs("edit_file", partial);
    expect(out?.path).toBe("a.ts");
    expect(out?.content).toBe("line1\nline2\nlin");
  });

  it("does not confuse new_content with content, and reads new_content for replace", () => {
    const partial = '{"operation":"replace","path":"x.ts","old_content":"a","new_content":"b\\nc';
    const out = extractPartialToolArgs("edit_file", partial);
    expect(out?.operation).toBe("replace");
    expect(out?.content).toBe("b\nc");
  });

  it("handles escaped quotes inside content without treating them as the terminator", () => {
    const partial = '{"path":"a.ts","content":"say \\"hi\\" the';
    const out = extractPartialToolArgs("edit_file", partial);
    expect(out?.content).toBe('say "hi" the');
  });

  it("tolerates a dangling backslash at the truncated tail", () => {
    const partial = '{"path":"a.ts","content":"line\\';
    const out = extractPartialToolArgs("edit_file", partial);
    expect(out?.content).toBe("line");
  });

  it("returns null when neither path nor content is present yet", () => {
    expect(extractPartialToolArgs("edit_file", '{"operati')).toBeNull();
  });

  it("streams the plan body live for a plan write (no file path)", () => {
    const partial =
      '{"operation":"write","title":"Auth plan","content":"## Step 1\\nDo the thing\\n## Step';
    const out = extractPartialToolArgs("plan", partial);
    expect(out?.operation).toBe("write");
    expect(out?.path).toBe("Auth plan"); // title stands in for the (absent) path
    expect(out?.content).toBe("## Step 1\nDo the thing\n## Step");
  });

  it("falls back to a generic plan label when no title yet", () => {
    const out = extractPartialToolArgs("plan", '{"operation":"write","content":"# Plan\\n');
    expect(out?.path).toBe("Plan");
    expect(out?.content).toBe("# Plan\n");
  });

  it("returns null for a plan op with no body (e.g. set_status)", () => {
    expect(
      extractPartialToolArgs("plan", '{"operation":"set_status","plan_status":"building"}'),
    ).toBeNull();
  });
});
