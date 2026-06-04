/**
 * Lightweight perf marks (v10.1 startup/large-repo profiling).
 * `[perf]` log lines measure open-workspace → first-prompt latency; grep the
 * main log for "[perf]" when profiling large repos.
 */

import log from "electron-log";

const logger = log.scope("perf");
const marks = new Map<string, number>();
const reported = new Set<string>();

export function perfMark(key: string): void {
  marks.set(key, Date.now());
}

/** Log the elapsed time since `mark(key)` once per key (no-op if unmarked). */
export function perfReportOnce(key: string, label: string): void {
  if (reported.has(key)) return;
  const start = marks.get(key);
  if (start == null) return;
  reported.add(key);
  logger.info(`[perf] ${label}: ${Date.now() - start}ms`);
}
