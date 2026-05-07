/**
 * Normalizes permission / access errors during filesystem walks so callers can skip
 * paths instead of crashing (e.g. Windows venv `lib64` symlinks without Developer Mode).
 */

import log from "electron-log";

const logger = log.scope("fs-access");

export function isFsAccessDenied(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "EACCES" || code === "EPERM";
}

/** User-facing line for toasts / IPC (no stack traces). */
export function fsAccessDeniedUserMessage(filePath: string): string {
  return `Couldn't access ${filePath} — check folder permissions`;
}

export function warnFsPathSkipped(filePath: string, err: unknown): void {
  if (!isFsAccessDenied(err)) return;
  logger.warn(`[FS] Permission denied, skipping: ${filePath}`, err);
}
