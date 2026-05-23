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
  error?: string;
};

parentPort?.on("message", async (msg: WorkerRequest) => {
  try {
    const byFile = buildSymbolLookup(msg.symbols);
    const allEdges: RTEBlueprintEdge[] = [];
    for (const rel of msg.relFiles) {
      const fileEdges = await scanFileStructuralEdges(msg.projectRoot, rel, byFile);
      allEdges.push(...fileEdges);
    }
    const res: WorkerResponse = { id: msg.id, edges: allEdges };
    parentPort?.postMessage(res);
  } catch (err) {
    parentPort?.postMessage({
      id: msg.id,
      edges: [],
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
