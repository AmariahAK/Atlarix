import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolRegistry } from "@/lib/tools";

/**
 * v14.8.7 §B — edit_file repairs model over-escaping end-to-end (the live-observed
 * bug: 3 Qwens + DeepSeek wrote literal `\n` and couldn't self-recover).
 *
 * The tool returns a __permission_required proposal whose preview.content is the
 * exact bytes that will hit disk — so asserting on preview.content is asserting
 * on the on-disk result.
 */

let ws: string;

beforeAll(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-escape-"));
  fs.writeFileSync(path.join(ws, "existing.ts"), "export const a = 1;\n");
});

afterAll(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

describe("edit_file over-escape repair (write)", () => {
  it("converts an over-escaped file body to real newlines", async () => {
    const result: any = await ToolRegistry.execute("edit_file", {
      path: "collapsed.ts",
      operation: "write",
      // Whole file collapsed to one physical line with literal backslash-n.
      content:
        'import a from "b";\\nimport c from "d";\\n\\nfunction f() {\\n  return 1;\\n}\\n',
      workspace: ws,
      chatMode: "build",
    });
    expect(result.__permission_required).toBe(true);
    expect(result.preview.content).toContain("\n");
    expect(result.preview.content).not.toContain("\\n");
    expect(result.preview.notice).toContain("over-escaped");
    expect(result.preview.content.split("\n").length).toBeGreaterThan(3);
  });

  it("writes a legit one-line \\n string literal verbatim (no false repair)", async () => {
    const result: any = await ToolRegistry.execute("edit_file", {
      path: "legit.ts",
      operation: "write",
      content: 'export const sep = "a\\nb";',
      workspace: ws,
      chatMode: "build",
    });
    expect(result.__permission_required).toBe(true);
    expect(result.preview.content).toBe('export const sep = "a\\nb";');
    expect(result.preview.notice).toBeUndefined();
  });

  it("hard-blocks ambiguous partial over-escaping with actionable guidance", async () => {
    const result: any = await ToolRegistry.execute("edit_file", {
      path: "mixed.ts",
      operation: "write",
      content: "function f() {\n  const x = 1;\\n  return x;\\n}\n",
      workspace: ws,
      chatMode: "build",
    });
    expect(result.__permission_required).toBeUndefined();
    // edit_file errors ride as { error, operation } → execute wraps them under
    // result.result (they carry no success:false today; C4 unifies this).
    const err = result.result?.error ?? result.error;
    expect(err).toContain("over-escaped");
    expect(String(err).toLowerCase()).toContain("real newline");
  });
});

/**
 * SYMMETRY RULE — the write side must receive whatever normalization let the
 * find side match.
 *
 * Live bug (2026-07-28, loki/pkg/logql/engine_test.go): a model sent old_content
 * and new_content with backslash-escaped quotes. The `escape` replacer matched
 * by un-escaping old_content, but new_content was spliced VERBATIM, so literal
 * `\"` landed inside Go raw-string literals — which cannot contain escapes —
 * and broke the build. reindentReplacement deliberately short-circuits on
 * escape fuzz (edit-match.ts:505-514), so nothing corrected it.
 */
describe("edit_file escape symmetry (replace)", () => {
  const GO_FILE = "engine_test.go";

  beforeAll(() => {
    fs.writeFileSync(
      path.join(ws, GO_FILE),
      "func TestX(t *testing.T) {\n" +
        "\ttests := []struct{}{\n" +
        '\t\t{newSeries(testSize, identity, `{app="foo"}`)},\n' +
        "\t}\n" +
        "}\n",
    );
  });

  it("un-escapes new_content when the escape replacer matched (Go raw string)", async () => {
    const result: any = await ToolRegistry.execute("edit_file", {
      path: GO_FILE,
      operation: "replace",
      // Both sides carry escapes the file does not have. Only `escape` can match.
      old_content: '\t\t{newSeries(testSize, identity, `{app=\\"foo\\"}`)},',
      new_content: '\t\t{newSeries(testSize, identity, `{app=\\"bar\\"}`)},',
      description: "Rename series label",
      workspace: ws,
      chatMode: "build",
    });

    expect(result.__permission_required).toBe(true);
    // The bytes that reach disk must carry REAL quotes, not backslash-quote.
    expect(result.preview.content).toContain('`{app="bar"}`');
    expect(result.preview.content).not.toContain('\\"bar\\"');
    // ...and the whole file must still be free of laundered escapes.
    expect(result.preview.content).not.toContain('\\"');

    // The notice must name escape-normalization, not indentation.
    expect(result.preview.notice).toContain("escape-normalized matching");
    expect(result.preview.notice).toContain("un-escaped");
    expect(result.preview.notice).not.toContain("indent/EOL");
  });

  it("leaves a genuine escape in new_content alone when the match was exact", async () => {
    fs.writeFileSync(path.join(ws, "quoted.go"), 'func f() {\n\ts := "a"\n}\n');
    const result: any = await ToolRegistry.execute("edit_file", {
      path: "quoted.go",
      operation: "replace",
      // Exact match — no strategy fired, so no transform may be applied and the
      // intended \n escape inside the interpreted string literal must survive.
      old_content: '\ts := "a"',
      new_content: '\ts := "a\\nb"',
      description: "Add newline escape",
      workspace: ws,
      chatMode: "build",
    });

    expect(result.__permission_required).toBe(true);
    expect(result.preview.content).toContain('"a\\nb"');
    expect(result.preview.notice).toBeUndefined();
  });
});

/**
 * The harness absorbs the mistake rather than prompting against it. Models emit
 * `file_path` (Claude Code) or `filePath` (opencode) from training prior; that
 * used to fail as a missing required parameter, and the system prompt carried a
 * standing clause telling the model not to. The clause cost tokens every turn
 * and still missed. Aliases never miss.
 */
describe("edit_file accepts path aliases", () => {
  for (const key of ["file_path", "filePath", "filename", "file"] as const) {
    it(`resolves the target from \`${key}\``, async () => {
      const result: any = await ToolRegistry.execute("edit_file", {
        [key]: "aliased.ts",
        operation: "write",
        content: "export const x = 1;\n",
        workspace: ws,
        chatMode: "build",
      });
      expect(result.__permission_required).toBe(true);
      expect(result.preview.path).toBe("aliased.ts");
    });
  }

  it("prefers the canonical `path` when both are present", async () => {
    const result: any = await ToolRegistry.execute("edit_file", {
      path: "canonical.ts",
      file_path: "alias.ts",
      operation: "write",
      content: "export const x = 1;\n",
      workspace: ws,
      chatMode: "build",
    });
    expect(result.preview.path).toBe("canonical.ts");
  });

  it("still reports a missing target when neither path nor any alias is supplied", async () => {
    const result: any = await ToolRegistry.execute("edit_file", {
      operation: "write",
      content: "export const x = 1;\n",
      workspace: ws,
      chatMode: "build",
    });
    // Canonicalisation had nothing to fill, so the guard's required-field check
    // rejects it — and its message is the better one, since it also reports the
    // keys the model DID send for it to diff against.
    expect(result.error).toBe("INVALID_PARAMS");
    expect(result.message).toContain("path");
    expect(result.received).toContain("operation");
  });
});

describe("edit_file mode gating", () => {
  it("refuses every edit in Plan mode, including .atlarix docs", async () => {
    const result: any = await ToolRegistry.execute("edit_file", {
      path: ".atlarix/memory.md",
      operation: "write",
      content: "# notes\n",
      workspace: ws,
      chatMode: "plan",
    });
    expect(result.__permission_required).toBeUndefined();
    expect(result.denied ?? result.result?.denied).toBe(true);
    const err = result.result?.error ?? result.error;
    expect(err).toContain("Plan mode");
    expect(err).toContain("plan tool");
  });
});

describe("edit_file removed ops are gone", () => {
  it("rejects operation=insert (op removed in v14.8.7)", async () => {
    const result: any = await ToolRegistry.execute("edit_file", {
      path: "existing.ts",
      operation: "insert",
      line: 1,
      new_content: "// x",
      workspace: ws,
      chatMode: "build",
    });
    expect(result.__permission_required).toBeUndefined();
    const err = result.result?.error ?? result.error;
    expect(err).toContain("Unknown operation");
    expect(err).toContain("write | replace");
  });
});
