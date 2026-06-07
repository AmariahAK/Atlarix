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
  /** Task id currently running on this slot, so a crash can resolve it. */
  currentTaskId?: number;
};

let pool: PoolWorker[] | null = null;
let taskId = 0;
const pending = new Map<number, PendingTask>();
const queue: Array<AstGrepScanBatch & { resolve: (edges: RTEBlueprintEdge[]) => void }> = [];

// v12 Tier 6 #4: count batches whose edges were lost to a worker crash/timeout
// so get_blueprint can flag a degraded parse instead of silently under-reporting
// connectivity.
let scanErrorCount = 0;
export function getAstGrepScanErrors(): number {
  return scanErrorCount;
}
export function resetAstGrepScanErrors(): void {
  scanErrorCount = 0;
}

// v12 S20 (Tier 6): per-scan tally of call sites whose callee is not a bare
// identifier (member/computed/expression calls) — no edge is produced for
// them, so get_blueprint discloses the count instead of silently dropping.
// Same reset-per-scan lifecycle as the error counter above.
let dynamicCallTally = 0;
export function getAstGrepDynamicCalls(): number {
  return dynamicCallTally;
}
export function resetAstGrepDynamicCalls(): void {
  dynamicCallTally = 0;
}

function workerScriptPath(): string {
  const candidates: string[] = [];
  if (process.resourcesPath) {
    candidates.push(
      path.join(process.resourcesPath, "app.asar.unpacked", ".vite", "build", "astgrep_worker.js"),
      path.join(process.resourcesPath, "app.asar", ".vite", "build", "astgrep_worker.js"),
    );
  }
  candidates.push(
    path.join(__dirname, "astgrep_worker.js"),
    path.resolve(process.cwd(), ".vite/build/astgrep_worker.js"),
    path.resolve(__dirname, "..", "..", "..", "astgrep_worker.js"),
  );
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
    slot.currentTaskId = id;
    const timer = setTimeout(() => {
      pending.delete(id);
      scanErrorCount++;
      logger.warn("[ast-grep-pool] batch timeout — edges lost");
      slot.busy = false;
      slot.currentTaskId = undefined;
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
  const script = workerScriptPath();
  pool = [];
  for (let i = 0; i < poolSize(); i++) {
    const worker = new Worker(script);
    const slot: PoolWorker = { worker, busy: false };
    worker.on("message", (msg: { id: number; edges: RTEBlueprintEdge[]; dynamicCalls?: number; error?: string }) => {
      const p = pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(msg.id);
        if (msg.error) {
          scanErrorCount++;
          logger.error("[ast-grep-pool] batch error — edges lost", { error: msg.error });
        }
        if (typeof msg.dynamicCalls === "number") {
          dynamicCallTally += msg.dynamicCalls; // v12 S20
        }
        p.resolve(msg.edges ?? []);
      }
      slot.busy = false;
      slot.currentTaskId = undefined;
      dispatchQueue();
    });
    // v12 Tier 6 #4: a crashing worker used to free the slot but leave its
    // in-flight task hanging until the 60s timeout. Resolve it now (empty,
    // counted) so the parse degrades fast instead of stalling.
    const failInFlight = (reason: string) => {
      const id = slot.currentTaskId;
      slot.busy = false;
      slot.currentTaskId = undefined;
      if (id != null) {
        const p = pending.get(id);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(id);
          scanErrorCount++;
          logger.error(`[ast-grep-pool] ${reason} — in-flight batch edges lost`);
          p.resolve([]);
        }
      }
    };
    worker.on("error", (err) => {
      logger.error("[ast-grep-pool] worker error", err);
      failInFlight("worker error");
      dispatchQueue();
    });
    worker.on("exit", (code) => {
      if (code !== 0) {
        logger.error("[ast-grep-pool] worker exited", { code });
        failInFlight(`worker exited (${code})`);
        dispatchQueue();
      } else {
        slot.busy = false;
        slot.currentTaskId = undefined;
      }
    });
    pool.push(slot);
  }
  logger.info(`[ast-grep-pool] initialized ${pool.length} workers`, { script });
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

/** When set, structural scans run in-process (used by CI bench; bundled worker is unreliable in worker_threads). */
export function preferInProcessAstGrep(): boolean {
  return process.env.ATLARIX_ASTGREP_IN_PROCESS === "1";
}

export function isAstGrepWorkerPoolAvailable(): boolean {
  if (preferInProcessAstGrep()) return false;
  return workerScriptAvailable();
}
