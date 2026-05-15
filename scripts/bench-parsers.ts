/**
 * Parser benchmarks for CI gate.
 * Run: npx tsx scripts/bench-parsers.ts
 */

import { parseSync } from "oxc-parser";
import { extractWithWasm } from "../src/lib/blueprint/rte/parsers/wasm-extract";

function buildTsSource(lines: number): string {
  const parts: string[] = ["import React from 'react';\n"];
  for (let i = 0; i < lines; i++) {
    parts.push(`export function fn_${i}(n: number): number { return n + 1; }\n`);
  }
  parts.push("export default function Root() { return <motion.div />; }\n");
  return parts.join("");
}

function buildPythonSource(lines: number): string {
  const parts: string[] = ["from typing import List\n\n"];
  for (let i = 0; i < lines; i++) {
    parts.push(`def handler_${i}(x: int) -> int:\n    return x + 1\n\n`);
  }
  parts.push("class App:\n    def run(self) -> None:\n        pass\n");
  return parts.join("");
}

const OXC_LINES = 3000;
const OXC_LIMIT_MS = 150;
const WASM_LINES = 2000;
const WASM_LIMIT_MS = 500;

const tsSource = buildTsSource(OXC_LINES);
const pySource = buildPythonSource(WASM_LINES);

const oxcT0 = performance.now();
const oxcResult = parseSync("bench-synthetic.tsx", tsSource);
const oxcElapsed = performance.now() - oxcT0;

if (oxcResult.errors.length > 0) {
  console.error("oxc parse errors:", oxcResult.errors);
  process.exit(1);
}

console.log(`oxc bench: ${OXC_LINES} lines, ${oxcElapsed.toFixed(1)}ms (limit ${OXC_LIMIT_MS}ms)`);
if (oxcElapsed > OXC_LIMIT_MS) {
  console.error(`FAIL: oxc exceeded ${OXC_LIMIT_MS}ms`);
  process.exit(1);
}

async function runWasmBench(): Promise<void> {
  const wasmT0 = performance.now();
  const wasmNodes = await extractWithWasm(pySource, "python", "bench-synthetic.py", 0);
  const wasmElapsed = performance.now() - wasmT0;

  if (wasmNodes.length === 0) {
    console.error("FAIL: wasm python extract returned no nodes");
    process.exit(1);
  }

  console.log(
    `wasm python bench: ${WASM_LINES} lines, ${wasmNodes.length} nodes, ${wasmElapsed.toFixed(1)}ms (limit ${WASM_LIMIT_MS}ms)`,
  );
  if (wasmElapsed > WASM_LIMIT_MS) {
    console.error(`FAIL: wasm exceeded ${WASM_LIMIT_MS}ms`);
    process.exit(1);
  }
}

runWasmBench()
  .then(() => {
    console.log("PASS");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
