import { describe, expect, it } from "vitest";
import { resolveRelativeImport } from "../lib/blueprint/rte/ast-grep/resolve-edges";
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
