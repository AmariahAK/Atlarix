import { describe, expect, it } from "vitest";
import {
  buildToolExpandView,
  parseGrepDisplayText,
  splitPathForDisplay,
} from "@/lib/chat/tool-expand-view";

describe("splitPathForDisplay", () => {
  it("splits path into name and directory", () => {
    expect(splitPathForDisplay("Atlarix/src/foo.ts")).toEqual({
      fileName: "foo.ts",
      directory: "./Atlarix/src",
    });
  });
});

describe("parseGrepDisplayText", () => {
  it("parses file blocks and match counts", () => {
    const text = `Found 3 match(es) for "foo" across 2 file(s):

📄 src/a.ts
  10: const foo = 1
  20: foo bar

📄 src/b.ts
  5: foo
`;
    const files = parseGrepDisplayText(text);
    expect(files).toHaveLength(2);
    expect(files[0]!.matchCount).toBe(2);
    expect(files[1]!.matchCount).toBe(1);
  });
});

describe("buildToolExpandView", () => {
  it("formats explore_folder as file_list", () => {
    const raw = JSON.stringify({
      success: true,
      result: {
        total: 2,
        items: [
          { path: "src/a.ts", type: "file" },
          { path: "src/b.ts", type: "file" },
        ],
      },
    });
    const view = buildToolExpandView("explore_folder", { path: "." }, raw, "done");
    expect(view.kind).toBe("file_list");
    if (view.kind === "file_list") {
      expect(view.total).toBe(2);
      expect(view.entries[0]!.fileName).toBe("a.ts");
    }
  });

  it("formats search ui.groups as match_list", () => {
    const raw = JSON.stringify({
      success: true,
      result: "Found 2 matches…",
      ui: {
        groups: [
          { file: "src/a.ts", matchCount: 2 },
          { file: "src/b.ts", matchCount: 1 },
        ],
      },
    });
    const view = buildToolExpandView("search_code", { query: "x" }, raw, "done");
    expect(view.kind).toBe("match_list");
    if (view.kind === "match_list") {
      expect(view.totalMatches).toBe(3);
      expect(view.files[0]!.matchCount).toBe(2);
    }
  });

  it("formats write_file with old and new content as diff", () => {
    const raw = JSON.stringify({
      success: true,
      path: "src/x.ts",
      oldContent: "a\n",
      newContent: "a\nb\n",
      operation: "update",
    });
    const view = buildToolExpandView("write_file", { path: "src/x.ts" }, raw, "done");
    expect(view.kind).toBe("diff");
    if (view.kind === "diff") {
      expect(view.fileName).toBe("x.ts");
      expect(view.newContent).toContain("b");
    }
  });

  it("uses text fallback for errors without JSON dump", () => {
    const raw = JSON.stringify({ success: false, error: "Permission denied" });
    const view = buildToolExpandView("read_file", {}, raw, "error");
    expect(view.kind).toBe("text");
    if (view.kind === "text") {
      expect(view.body).toContain("Permission denied");
      expect(view.body).not.toContain('"success"');
    }
  });
});
