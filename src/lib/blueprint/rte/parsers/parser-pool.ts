/**
 * worker_threads pool for oxc-parser — keeps parseSync off the main process.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import log from "electron-log";
import type { BlueprintNode } from "./types";
import { OXC_MAX_BYTES, isTsLikePath } from "./oxc-extract";
import { oxcParseProgram } from "./oxc-parse";
import { walkProgramToNodes } from "./oxc-program-walk";
type ParserWorkerRequest = {
  id: number;
  filePath: string;
  source: string;
  relPath: string;
  idOffset: number;
};

type ParserWorkerResponse = {
  id: number;
  nodes: BlueprintNode[];
  error?: string;
};

const logger = log.scope("blueprint:parser-pool");

const PARSE_TIMEOUT_MS = 5000;

type PendingTask = {
  resolve: (nodes: BlueprintNode[]) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PoolWorker = {
  worker: Worker;
  busy: boolean;
  currentTaskId: number | null;
};

let pool: PoolWorker[] | null = null;
let taskId = 0;
const pending = new Map<number, PendingTask>();
const queue: Array<{
  filePath: string;
  source: string;
  relPath: string;
  idOffset: number;
  resolve: (nodes: BlueprintNode[]) => void;
}> = [];

function workerScriptPath(): string {
  return path.join(__dirname, "parser_worker.js");
}

function workerScriptAvailable(): boolean {
  try {
    return fs.existsSync(workerScriptPath());
  } catch {
    return false;
  }
}

function parseSyncFallback(
  filePath: string,
  source: string,
  relPath: string,
  idOffset: number,
): BlueprintNode[] {
  const program = oxcParseProgram(filePath, source);
  if (!program) return [];
  return walkProgramToNodes(program, relPath, idOffset);
}

function poolSize(): number {
  return Math.max(2, Math.min(4, os.cpus().length - 1));
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
      logger.warn(`[parser-pool] timeout ${task.relPath}`);
      slot.busy = false;
      task.resolve([]);
      dispatchQueue();
    }, PARSE_TIMEOUT_MS);

    pending.set(id, { resolve: task.resolve, timer });
    slot.currentTaskId = id;

    slot.worker.postMessage({
      id,
      filePath: task.filePath,
      source: task.source,
      relPath: task.relPath,
      idOffset: task.idOffset,
    } satisfies ParserWorkerRequest);
  }
}

function attachWorkerHandlers(slot: PoolWorker): void {
  slot.worker.on("message", (msg: ParserWorkerResponse) => {
    const p = pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(msg.id);
    slot.busy = false;
    slot.currentTaskId = null;
    if (msg.error) {
      logger.warn(`[parser-pool] worker error: ${msg.error}`);
    }
    p.resolve(msg.nodes ?? []);
    dispatchQueue();
  });

  slot.worker.on("error", (err) => {
    logger.error("[parser-pool] worker error event", err);
    replaceWorker(slot);
  });

  slot.worker.on("exit", (code) => {
    if (code !== 0) {
      logger.warn(`[parser-pool] worker exited ${code}`);
      replaceWorker(slot);
    }
  });
}

function replaceWorker(oldSlot: PoolWorker): void {
  if (!pool) return;
  const idx = pool.indexOf(oldSlot);
  if (idx === -1) return;

  const lostId = oldSlot.currentTaskId;
  if (lostId != null) {
    const p = pending.get(lostId);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(lostId);
      p.resolve([]);
    }
  }

  try {
    oldSlot.worker.terminate();
  } catch {
    /* ignore */
  }

  const worker = new Worker(workerScriptPath());
  const slot: PoolWorker = { worker, busy: false, currentTaskId: null };
  pool[idx] = slot;
  attachWorkerHandlers(slot);
  dispatchQueue();
}

export function initParserPool(): void {
  if (pool) return;
  pool = [];
  const n = poolSize();
  for (let i = 0; i < n; i++) {
    const worker = new Worker(workerScriptPath());
    const slot: PoolWorker = { worker, busy: false, currentTaskId: null };
    pool.push(slot);
    attachWorkerHandlers(slot);
  }
  logger.info(`[parser-pool] initialized ${n} workers`);
}

export async function shutdownParserPool(): Promise<void> {
  if (!pool) return;
  const workers = pool;
  pool = null;
  queue.length = 0;
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.resolve([]);
  }
  pending.clear();
  await Promise.all(
    workers.map((s) =>
      s.worker.terminate().catch(() => {
        /* ignore */
      }),
    ),
  );
  logger.info("[parser-pool] shutdown complete");
}

/**
 * Parse TS/JS source in a worker thread. Returns [] on timeout, crash, or skip.
 */
export function parseInWorker(
  filePath: string,
  source: string,
  relPath: string,
  idOffset: number,
): Promise<BlueprintNode[]> {
  if (!isTsLikePath(filePath)) return Promise.resolve([]);
  if (Buffer.byteLength(source, "utf8") > OXC_MAX_BYTES) return Promise.resolve([]);

  if (!workerScriptAvailable()) {
    return Promise.resolve(parseSyncFallback(filePath, source, relPath, idOffset));
  }

  initParserPool();

  return new Promise((resolve) => {
    queue.push({ filePath, source, relPath, idOffset, resolve });
    dispatchQueue();
  });
}
