/**
 * worker_threads pool for @ast-grep/napi — keeps native AST work off the main process.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import log from "electron-log";
import type { RTEBlueprintEdge } from "../parsers/types";
import type { SymbolRecord } from "@/lib/index/symbol-types";

const logger = log.scope("ast-grep:worker-pool");

const SCAN_TIMEOUT_MS = 60_000;

export type AstGrepScanBatch = {
  projectRoot: string;
  relFiles: string[];
  symbols: SymbolRecord[];
};

type PendingTask = {
  resolve: (edges: RTEBlueprintEdge[]) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PoolWorker = {
  worker: Worker;
  busy: boolean;
};

let pool: PoolWorker[] | null = null;
let taskId = 0;
const pending = new Map<number, PendingTask>();
const queue: Array<AstGrepScanBatch & { resolve: (edges: RTEBlueprintEdge[]) => void }> = [];

function workerScriptPath(): string {
  const candidates = [
    path.join(__dirname, "astgrep_worker.js"),
    path.resolve(process.cwd(), ".vite/build/astgrep_worker.js"),
    path.resolve(__dirname, "..", "..", "..", "astgrep_worker.js"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
}

function workerScriptAvailable(): boolean {
  try {
    return fs.existsSync(workerScriptPath());
  } catch {
    return false;
  }
}

function poolSize(): number {
  return Math.max(1, Math.min(2, os.cpus().length - 1));
}

function dispatchQueue(): void {
  if (!pool) return;
  for (const slot of pool) {
    if (slot.busy || queue.length === 0) continue;
    const task = queue.shift()!;
    slot.busy = true;
    const id = ++taskId;
    const timer = setTimeout(() => {
      pending.delete(id);
      logger.warn("[ast-grep-pool] batch timeout");
      slot.busy = false;
      task.resolve([]);
      dispatchQueue();
    }, SCAN_TIMEOUT_MS);

    pending.set(id, { resolve: task.resolve, timer });
    slot.worker.postMessage({
      id,
      projectRoot: task.projectRoot,
      relFiles: task.relFiles,
      symbols: task.symbols,
    });
  }
}

function ensurePool(): void {
  if (pool) return;
  if (!workerScriptAvailable()) {
    pool = [];
    return;
  }
  pool = [];
  for (let i = 0; i < poolSize(); i++) {
    const worker = new Worker(workerScriptPath());
    const slot: PoolWorker = { worker, busy: false };
    worker.on("message", (msg: { id: number; edges: RTEBlueprintEdge[]; error?: string }) => {
      const p = pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(msg.id);
        p.resolve(msg.edges ?? []);
      }
      slot.busy = false;
      dispatchQueue();
    });
    worker.on("error", (err) => {
      logger.error("[ast-grep-pool] worker error", err);
      slot.busy = false;
      dispatchQueue();
    });
    pool.push(slot);
  }
  logger.info(`[ast-grep-pool] initialized ${pool.length} workers`);
}

export function scanBatchInWorker(batch: AstGrepScanBatch): Promise<RTEBlueprintEdge[]> {
  ensurePool();
  if (!pool?.length) {
    return Promise.resolve([]);
  }
  return new Promise((resolve) => {
    queue.push({ ...batch, resolve });
    dispatchQueue();
  });
}

export async function shutdownAstGrepPool(): Promise<void> {
  if (!pool) return;
  await Promise.all(pool.map((s) => s.worker.terminate()));
  pool = null;
  pending.clear();
  queue.length = 0;
  logger.info("[ast-grep-pool] shutdown complete");
}

export function isAstGrepWorkerPoolAvailable(): boolean {
  return workerScriptAvailable();
}
