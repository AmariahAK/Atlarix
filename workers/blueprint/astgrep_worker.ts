/**
 * worker_threads entry: ast-grep structural edge scan off the main process.
 */

import { parentPort } from "node:worker_threads";
import type { RTEBlueprintEdge } from "../../src/lib/blueprint/rte/parsers/types";
import type { SymbolRecord } from "../../src/lib/index/symbol-types";
import { ensureAstGrepDynamicLangs } from "../../src/lib/blueprint/rte/ast-grep/register-dynamic-langs";
import {
  buildSymbolLookup,
  scanFileStructuralEdges,
} from "../../src/lib/blueprint/rte/ast-grep/scan-file-edges";

ensureAstGrepDynamicLangs();

type WorkerRequest = {
  id: number;
  projectRoot: string;
  relFiles: string[];
  symbols: SymbolRecord[];
};

type WorkerResponse = {
  id: number;
  edges: RTEBlueprintEdge[];
  /** v12 S20: call sites with non-identifier callees (no edge produced). */
  dynamicCalls?: number;
  error?: string;
};

parentPort?.on("message", async (msg: WorkerRequest) => {
  try {
    const byFile = buildSymbolLookup(msg.symbols);
    const allEdges: RTEBlueprintEdge[] = [];
    let dynamicCalls = 0;
    for (const rel of msg.relFiles) {
      const fileResult = await scanFileStructuralEdges(msg.projectRoot, rel, byFile);
      allEdges.push(...fileResult.edges);
      dynamicCalls += fileResult.dynamicCalls;
    }
    const res: WorkerResponse = { id: msg.id, edges: allEdges, dynamicCalls };
    parentPort?.postMessage(res);
  } catch (err) {
    parentPort?.postMessage({
      id: msg.id,
      edges: [],
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
