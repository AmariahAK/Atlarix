/**
 * Blueprint index benchmarks for CI gate.
 * Run: npx tsx scripts/bench-blueprint-index.ts
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureSymbolIndex } from "../src/lib/index/ctags-index";
import { runStructuralScan } from "../src/lib/blueprint/rte/ast-grep/run-structural-scan";

const FILE_COUNT = 100;
const CTAGS_WARM_LIMIT_MS = 5000;
const AST_GREP_LIMIT_MS = 10000;

async function buildFixture(root: string): Promise<string[]> {
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  const files: string[] = [];
  for (let i = 0; i < FILE_COUNT; i++) {
    const rel = `src/module_${i}.ts`;
    const target = i > 0 ? `./module_${i - 1}` : "./module_0";
    const content = `import { fn_${Math.max(0, i - 1)} } from '${target}';\nexport function fn_${i}(n: number): number {\n  return fn_${Math.max(0, i - 1)}(n) + 1;\n}\n`;
    await fs.writeFile(path.join(root, rel), content, "utf-8");
    files.push(rel);
  }
  return files;
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-bench-"));
  try {
    const files = await buildFixture(root);

    const ctagsT0 = performance.now();
    const index = await ensureSymbolIndex(root);
    const ctagsElapsed = performance.now() - ctagsT0;
    console.log(
      `ctags warm: ${index.symbols.length} symbols, ${ctagsElapsed.toFixed(1)}ms (limit ${CTAGS_WARM_LIMIT_MS}ms)`,
    );
    if (ctagsElapsed > CTAGS_WARM_LIMIT_MS) {
      console.error(`FAIL: ctags exceeded ${CTAGS_WARM_LIMIT_MS}ms`);
      process.exit(1);
    }

    const scanT0 = performance.now();
    const scan = await runStructuralScan(root, files, index.symbols);
    const scanElapsed = performance.now() - scanT0;
    console.log(
      `ast-grep scan: ${scan.edges.length} edges, ${scanElapsed.toFixed(1)}ms (limit ${AST_GREP_LIMIT_MS}ms)`,
    );
    if (scanElapsed > AST_GREP_LIMIT_MS) {
      console.error(`FAIL: ast-grep scan exceeded ${AST_GREP_LIMIT_MS}ms`);
      process.exit(1);
    }

    console.log("PASS");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
