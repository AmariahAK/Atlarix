/**
 * PTY session manager (v10 interactive terminal)
 * ==============================================
 * Real interactive shells for USER terminal tabs via @lydell/node-pty +
 * xterm.js — native Tab completion, arrows, colors, and interactive apps
 * (vim/top). One PTY per terminal instance id; data streams to the renderer
 * over `pty:data` / `pty:exit`.
 *
 * The AGENT's `run_command` path is untouched — it stays on piped
 * `runShellCommand` so output capture, permissions, and timeouts keep working.
 */

import log from "electron-log";
import { BrowserWindow } from "electron";
import { getInteractiveShell } from "@/lib/shell/resolve-shell";

const logger = log.scope("pty");

type PtyProcess = {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): {
    dispose(): void;
  };
  pid: number;
};

type Session = {
  pty: PtyProcess;
  cwd: string;
  scopeKey?: string;
};

const sessions = new Map<string, Session>();

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

export type SpawnPtyResult =
  | { ok: true; pid: number }
  | { ok: false; error: string };

/** Spawn (or reuse) the interactive shell for a terminal instance. */
export async function spawnPty(params: {
  instanceId: string;
  cwd: string;
  cols?: number;
  rows?: number;
  scopeKey?: string;
}): Promise<SpawnPtyResult> {
  const { instanceId, cwd } = params;
  const existing = sessions.get(instanceId);
  if (existing) {
    return { ok: true, pid: existing.pty.pid };
  }
  try {
    // Lazy import: native module — failure must degrade to the legacy input UI.
    const nodePty = await import("@lydell/node-pty");
    const { file, args } = getInteractiveShell();
    const pty = nodePty.spawn(file, args, {
      name: "xterm-256color",
      cols: Math.max(20, params.cols ?? 80),
      rows: Math.max(5, params.rows ?? 24),
      cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      } as Record<string, string>,
    }) as unknown as PtyProcess;

    pty.onData((data) => {
      broadcast("pty:data", { instanceId, data });
    });
    pty.onExit(({ exitCode }) => {
      sessions.delete(instanceId);
      broadcast("pty:exit", { instanceId, exitCode });
      logger.log(`pty ${instanceId} exited (${exitCode})`);
    });

    sessions.set(instanceId, { pty, cwd, scopeKey: params.scopeKey });
    logger.log(`spawned pty ${instanceId} (${file}) pid=${pty.pid} cwd=${cwd}`);
    return { ok: true, pid: pty.pid };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`pty spawn failed for ${instanceId}: ${message}`);
    return { ok: false, error: message };
  }
}

export function writePty(instanceId: string, data: string): boolean {
  const session = sessions.get(instanceId);
  if (!session) return false;
  try {
    session.pty.write(data);
    return true;
  } catch (err) {
    logger.warn(`pty write failed for ${instanceId}:`, err);
    return false;
  }
}

export function resizePty(instanceId: string, cols: number, rows: number): void {
  const session = sessions.get(instanceId);
  if (!session) return;
  try {
    session.pty.resize(Math.max(20, cols), Math.max(5, rows));
  } catch {
    // resizing a dying pty is harmless
  }
}

export function killPty(instanceId: string): void {
  const session = sessions.get(instanceId);
  if (!session) return;
  sessions.delete(instanceId);
  try {
    session.pty.kill();
    logger.log(`killed pty ${instanceId}`);
  } catch {
    // already dead
  }
}

export function hasPty(instanceId: string): boolean {
  return sessions.has(instanceId);
}

/** Kill every PTY for a terminal scope (workspace/chat close). */
export function killPtysForScope(scopeKey: string): void {
  for (const [id, session] of sessions) {
    if (session.scopeKey === scopeKey) killPty(id);
  }
}

/** Kill everything (app quit / reset). */
export function killAllPtys(): void {
  // Snapshot first — killPty mutates the map while we iterate.
  const ids = Array.from(sessions.keys());
  for (const id of ids) killPty(id);
}
