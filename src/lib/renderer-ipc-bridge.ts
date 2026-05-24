/**
 * Single IPC subscriptions for high-frequency renderer channels (avoids MaxListenersExceeded).
 */

import type { App } from "@/ipc/ipc_types";

export type AppPathStatusPayload = {
  statuses: Array<{ id: number; pathExists: boolean; status: App["status"] }>;
};

type AutoSelfCorrectPayload = { chatId: number };

const autoSelfCorrectListeners = new Set<(data: AutoSelfCorrectPayload) => void>();
const appsStatusListeners = new Set<(data: AppPathStatusPayload) => void>();

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
