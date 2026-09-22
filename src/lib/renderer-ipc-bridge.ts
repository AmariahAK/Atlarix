/**
 * Single IPC subscriptions for high-frequency renderer channels (avoids MaxListenersExceeded).
 */

import type { App } from "@/ipc/ipc_types";

export type AppPathStatusPayload = {
  statuses: Array<{ id: number; pathExists: boolean; status: App["status"] }>;
};

type AutoSelfCorrectPayload = { chatId: number };

export type WorkspaceDeletedPayload = {
  appId: number;
  path?: string;
  name?: string;
  /** Live turns main aborted for this workspace before deleting it. */
  cancelledTurns?: number;
};

const autoSelfCorrectListeners = new Set<
  (data: AutoSelfCorrectPayload) => void
>();
const appsStatusListeners = new Set<(data: AppPathStatusPayload) => void>();
const workspaceDeletedListeners = new Set<
  (data: WorkspaceDeletedPayload) => void
>();
/**
 * The last deletion seen, replayed to late subscribers.
 *
 * Without it this is a race nobody would ever reproduce deliberately: the event
 * arrives while a window is still mounting, the hook subscribes a tick later,
 * and that window goes on showing a workspace that is already gone — which is
 * the exact failure the broadcast exists to fix. Same reason `auth-ipc-bridge`
 * retains `lastAuthResolved`.
 */
let lastWorkspaceDeleted: WorkspaceDeletedPayload | null = null;

let registered = false;

function ipcPayload<T>(args: unknown[]): T {
  return (args.length > 1 ? args[1] : args[0]) as T;
}

function ensureRegistered(): void {
  if (registered) return;
  const ipcRenderer = window.electron?.ipcRenderer;
  if (!ipcRenderer?.on) return;
  registered = true;

  ipcRenderer.on("chat:auto-self-correct", ((...args: unknown[]) => {
    const data = ipcPayload<AutoSelfCorrectPayload>(args);
    if (data?.chatId == null) return;
    for (const fn of autoSelfCorrectListeners) fn(data);
  }) as (...args: unknown[]) => void);

  ipcRenderer.on("apps:status-changed", ((...args: unknown[]) => {
    const data = ipcPayload<AppPathStatusPayload>(args);
    if (!data?.statuses?.length) return;
    for (const fn of appsStatusListeners) fn(data);
  }) as (...args: unknown[]) => void);

  ipcRenderer.on("workspace:deleted", ((...args: unknown[]) => {
    const data = ipcPayload<WorkspaceDeletedPayload>(args);
    if (data?.appId == null) return;
    lastWorkspaceDeleted = data;
    for (const fn of workspaceDeletedListeners) fn(data);
  }) as (...args: unknown[]) => void);
}

export function subscribeAutoSelfCorrect(
  fn: (data: AutoSelfCorrectPayload) => void,
): () => void {
  ensureRegistered();
  autoSelfCorrectListeners.add(fn);
  return () => autoSelfCorrectListeners.delete(fn);
}

export function subscribeAppsStatusChanged(
  fn: (data: AppPathStatusPayload) => void,
): () => void {
  ensureRegistered();
  appsStatusListeners.add(fn);
  return () => appsStatusListeners.delete(fn);
}

export function subscribeWorkspaceDeleted(
  fn: (data: WorkspaceDeletedPayload) => void,
): () => void {
  ensureRegistered();
  workspaceDeletedListeners.add(fn);
  // Replay, so a window that mounted a tick after the broadcast still learns.
  if (lastWorkspaceDeleted) fn(lastWorkspaceDeleted);
  return () => workspaceDeletedListeners.delete(fn);
}
