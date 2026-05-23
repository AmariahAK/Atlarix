/**
 * ast-grep structural scan: import + call edges for TS/JS/TSX, Python, and Go.
 */

import log from "electron-log";
import type { BlueprintNode, RTEBlueprintEdge } from "../parsers/types";
import { isAstGrepSupportedPath } from "./lang-map";
import { ctagsKindToNodeType } from "@/lib/index/ctags-parse";
import type { SymbolRecord } from "@/lib/index/symbol-types";
import { buildSymbolLookup, scanFileStructuralEdges } from "./scan-file-edges";
import {
  isAstGrepWorkerPoolAvailable,
  scanBatchInWorker,
} from "./worker-pool";

const logger = log.scope("ast-grep-structural");

const MAX_FILES_PER_SCAN = 5000;
const CONCURRENCY = 4;
const WORKER_BATCH_SIZE = 25;

export type StructuralScanResult = {
  nodes: BlueprintNode[];
  edges: RTEBlueprintEdge[];
};

function symbolsToNodes(symbols: SymbolRecord[]): BlueprintNode[] {
  return symbols.map((s) => ({
    id: s.id,
    type: ctagsKindToNodeType(s.kind),
    name: s.name,
    file: s.path.replace(/\\/g, "/"),
    line: s.line,
    description: s.signature ?? s.scope,
    simpleDescription: s.signature,
    descriptionSource: "pattern" as const,
  }));
}

async function runBatch<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx]);
    }
  }
  const workers = Math.min(Math.max(1, concurrency), items.length || 1);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

/**
 * Run ast-grep structural scan over project files, using ctags symbols for node ids.
 */
export async function runStructuralScan(
  projectRoot: string,
  relFiles: string[],
  symbols: SymbolRecord[],
): Promise<StructuralScanResult> {
  const t0 = Date.now();
  const nodes = symbolsToNodes(symbols);
  const byFile = buildSymbolLookup(symbols);

  const scanFiles = relFiles
    .filter(isAstGrepSupportedPath)
    .slice(0, MAX_FILES_PER_SCAN);

  let edges: RTEBlueprintEdge[] = [];

  if (isAstGrepWorkerPoolAvailable()) {
    for (let i = 0; i < scanFiles.length; i += WORKER_BATCH_SIZE) {
      const batch = scanFiles.slice(i, i + WORKER_BATCH_SIZE);
      const batchEdges = await scanBatchInWorker({
        projectRoot,
        relFiles: batch,
        symbols,
      });
      edges.push(...batchEdges);
    }
  } else {
    const edgeLists = await runBatch(
      scanFiles,
      (f) => scanFileStructuralEdges(projectRoot, f, byFile),
      CONCURRENCY,
    );
    edges = edgeLists.flat();
  }

  const edgeMap = new Map<string, RTEBlueprintEdge>();
  for (const e of edges) {
    edgeMap.set(`${e.from}->${e.to}:${e.type}`, e);
  }

  const deduped = [...edgeMap.values()];
  logger.info("runStructuralScan: complete", {
    projectRoot,
    files: scanFiles.length,
    nodes: nodes.length,
    edges: deduped.length,
    worker: isAstGrepWorkerPoolAvailable(),
    elapsedMs: Date.now() - t0,
  });

  return { nodes, edges: deduped };
}
