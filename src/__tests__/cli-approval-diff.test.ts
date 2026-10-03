import { describe, expect, it } from "vitest";
import { approvalDiff } from "@/cli/agent/approval-diff";

describe("the CLI approval diff", () => {
  it("is computed from old and new contents, whatever `diff` holds (edit_file sends an object)", () => {
    const d = approvalDiff({
      type: "update",
      oldContent: "a\nfunction add(a, b) {\n  return a - b;\n}\n",
      content: "a\nfunction add(a, b) {\n  return a + b;\n}\n",
      diff: { added: 1, removed: 1, old_snippet: "-", new_snippet: "+" },
    })!;
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
    expect(d.lines.find((l) => l.kind === "remove")?.text).toContain("return a - b;");
    expect(d.lines.find((l) => l.kind === "add")?.text).toContain("return a + b;");
  });

  it("a new file is all additions; a text diff still works; nothing usable is null", () => {
    expect(approvalDiff({ type: "create", content: "x\ny\n" })!.added).toBe(2);
    expect(approvalDiff({ diff: "@@ -1 +1 @@\n-old\n+new" })!.lines.map((l) => l.kind)).toEqual(["gap", "remove", "add"]);
    expect(approvalDiff({ diff: { added: 1 } })).toBeNull();
    expect(approvalDiff({})).toBeNull();
  });

  it("long diffs are cut, and say how much is left", () => {
    const d = approvalDiff({ type: "create", content: Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n") }, 14)!;
    expect(d.lines).toHaveLength(14);
    expect(d.more).toBe(26);
  });
});
