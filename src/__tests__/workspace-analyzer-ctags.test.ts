import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasCtags } from "./helpers/native-tools";
import {
  analyzeWorkspace,
  extractImportsUniversal,
} from "../lib/analysis/workspace-analyzer";
import { invalidateSymbolIndex } from "../lib/index/ctags-index";
import { clearFileListCache } from "../ipc/utils/project-files";

const tmpDirs: string[] = [];

afterEach(async () => {
  for (const root of tmpDirs) {
    invalidateSymbolIndex(root);
    clearFileListCache(root);
  }
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe.skipIf(!hasCtags())("workspace-analyzer via ctags", () => {
  it("derives structure from ctags symbols for any language", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-wa-"));
    tmpDirs.push(root);
    await fs.mkdir(path.join(root, "lib"), { recursive: true });
    await fs.mkdir(path.join(root, "app"), { recursive: true });
    // Ruby — a language the old per-language regex extractors did NOT cover.
    await fs.writeFile(
      path.join(root, "lib", "greeter.rb"),
      "class Greeter\n  def greet(name)\n    name\n  end\nend\n",
      "utf-8",
    );
    await fs.writeFile(
      path.join(root, "app", "main.rb"),
      "require 'json'\n\ndef run\nend\n",
      "utf-8",
    );

    const analysis = await analyzeWorkspace(root);

    expect(typeof analysis.language).toBe("string");
    expect(analysis.language).toBe("ruby"); // no marker file → dominant ctags language
    expect(analysis.files.length).toBeGreaterThan(0);

    const greeter = analysis.files.find((f) => f.relativePath === "lib/greeter.rb");
    expect(greeter).toBeDefined();
    expect(greeter!.classes).toContain("Greeter");
    expect(greeter!.functions).toContain("greet");
    expect(greeter!.language).toBe("ruby");
  });

  it("returns the minimal shape when the symbol index is unavailable", async () => {
    const ctagsIndex = await import("../lib/index/ctags-index");
    vi.spyOn(ctagsIndex, "ensureSymbolIndex").mockRejectedValueOnce(
      new Error("ctags missing"),
    );

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-wa-min-"));
    tmpDirs.push(root);

    const analysis = await analyzeWorkspace(root);
    expect(analysis).toMatchObject({
      language: "mixed",
      files: [],
      dependencies: [],
      clusters: [],
      entryPoints: [],
      metadata: { totalFiles: 0, languages: [], hubFiles: [] },
    });
  });
});

describe("extractImportsUniversal", () => {
  it("matches import shapes across languages without a language gate", () => {
    const snippets = [
      `import { a } from './a';`,
      `const b = require('./b');`,
      `import os.path`,
      `from collections import defaultdict`,
      `use std::collections::HashMap;`,
    ].join("\n");
    const imports = extractImportsUniversal(snippets);
    expect(imports).toEqual(
      expect.arrayContaining([
        "./a",
        "./b",
        "os.path",
        "collections",
        "std::collections::HashMap",
      ]),
    );
  });
});
