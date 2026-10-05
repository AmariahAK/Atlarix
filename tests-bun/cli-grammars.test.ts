/**
 * Grammars are found by language name, never from a list (owner, 2026-10-05):
 * one already on this machine first, else the language's own tree-sitter
 * project, else plain text. No network here: fetch is faked.
 */
import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { segmentLines } from "../src/cli/tui/diff-highlight";
import { localGrammar, remoteGrammar, sharedGrammarDir } from "../src/cli/tui/grammars";
import { codeColor } from "../src/cli/tui/theme";

describe("syntax grammars by name", () => {
  it("uses a grammar another opentui app already fetched", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grammars-"));
    fs.mkdirSync(path.join(dir, "languages"));
    fs.mkdirSync(path.join(dir, "queries"));
    fs.writeFileSync(path.join(dir, "languages", "tree-sitter-json.wasm"), "x");
    fs.writeFileSync(path.join(dir, "queries", "json-256dee0a.scm"), "(string) @string");
    expect(localGrammar("json", dir)).toEqual({
      filetype: "json",
      wasm: path.join(dir, "languages", "tree-sitter-json.wasm"),
      highlights: [path.join(dir, "queries", "json-256dee0a.scm")],
    });
    expect(localGrammar("python", dir)).toBeNull();
  });

  it("shares opentui's folder, honouring XDG_DATA_HOME", () => {
    expect(sharedGrammarDir({ XDG_DATA_HOME: "/data" } as NodeJS.ProcessEnv)).toBe(path.join("/data", "opentui", "tree-sitter"));
  });

  it("finds the language's own project by name, trying each organisation", async () => {
    const asked: string[] = [];
    const fake = (async (url: string) => {
      asked.push(url);
      return { ok: url.includes("tree-sitter-grammars/") } as Response;
    }) as unknown as typeof fetch;
    const g = await remoteGrammar("yaml", fake);
    expect(asked).toEqual([
      "https://github.com/tree-sitter/tree-sitter-yaml/releases/latest/download/tree-sitter-yaml.wasm",
      "https://github.com/tree-sitter-grammars/tree-sitter-yaml/releases/latest/download/tree-sitter-yaml.wasm",
    ]);
    expect(g?.highlights).toEqual(["https://raw.githubusercontent.com/tree-sitter-grammars/tree-sitter-yaml/HEAD/queries/highlights.scm"]);
  });

  it("no project, offline, or a strange name: plain text", async () => {
    const none = (async () => ({ ok: false }) as Response) as unknown as typeof fetch;
    expect(await remoteGrammar("nosuchlang", none)).toBeNull();
    const offline = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await remoteGrammar("python", offline)).toBeNull();
    expect(await remoteGrammar("../etc", none)).toBeNull();
  });

  it("a diff's lines are recoloured per token, the more specific capture winning", () => {
    // "def f():" / "return 1" joined with "\n": def=0-3, f=4-5, return=9-15, 1=16-17.
    const segs = segmentLines(["def f():", "return 1"], [
      [0, 3, "keyword"],
      [4, 5, "variable"],
      [4, 5, "function.method"],
      [9, 15, "keyword"],
      [16, 17, "number"],
    ]);
    expect(segs[0]![0]).toEqual({ text: "def", fg: codeColor("keyword")!.fg, italic: undefined });
    expect(segs[0]!.find((g) => g.text === "f")?.fg).toBe(codeColor("function")!.fg);
    expect(segs[1]!.map((g) => g.text).join("")).toBe("return 1");
    expect(segs[1]!.at(-1)).toEqual({ text: "1", fg: codeColor("number")!.fg, italic: undefined });
  });
});
