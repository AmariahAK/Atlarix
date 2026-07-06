import { describe, expect, it } from "vitest";
import { resolveRelativeImport } from "../lib/blueprint/rte/ast-grep/resolve-edges";
import {
  scanImportsForFile,
  scanCallsForFile,
} from "../lib/blueprint/rte/ast-grep/scan-file-edges";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

describe("ast-grep resolve-edges", () => {
  it("resolves relative TS imports to files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-ag-"));
    const srcDir = path.join(root, "src");
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, "util.ts"), "export const x = 1;\n");
    await fs.writeFile(path.join(srcDir, "main.ts"), "import { x } from './util';\n");

    const resolved = await resolveRelativeImport("./util", "src/main.ts", root);
    expect(resolved).toBe("src/util.ts");

    await fs.rm(root, { recursive: true, force: true });
  });
});

describe("ast-grep unsupported languages", () => {
  it("returns no edges for a file without a grammar (no TypeScript mis-parse)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-ag-rb-"));
    await fs.writeFile(
      path.join(root, "tool.rb"),
      "require 'json'\n\ndef greet(name)\n  puts(name)\nend\n",
    );

    const byFile = new Map();
    const imports = await scanImportsForFile(root, "tool.rb", byFile);
    expect(imports).toEqual([]);
    const calls = await scanCallsForFile(root, "tool.rb", byFile);
    expect(calls).toEqual({ edges: [], dynamicCalls: 0 });

    await fs.rm(root, { recursive: true, force: true });
  });
});
