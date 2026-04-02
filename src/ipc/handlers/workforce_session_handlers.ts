/**
 * Fix: Workforce-2 — IPC for in-memory per-chat Workforce session scope.
 */

import { ipcMain } from "electron";
import {
  clearWorkforceChatSession,
  getWorkforceChatSession,
  setWorkforceChatSessionScope,
} from "../../main/workforce-chat-session";

const scopeWaiters = new Map<number, (ok: boolean) => void>();

/** Called from chat stream after prompting renderer; resolves when UI calls complete-prompt. */
export function waitForWorkforceSessionScope(chatId: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    scopeWaiters.get(chatId)?.(false);
    let settled = false;
    const t = setTimeout(() => {
      if (!settled) {
        settled = true;
        scopeWaiters.delete(chatId);
        resolve(false);
      }
    }, timeoutMs);
    scopeWaiters.set(chatId, (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      scopeWaiters.delete(chatId);
      resolve(ok);
    });
  });
}

export function registerWorkforceSessionHandlers(): void {
  ipcMain.handle("workforce:session:get", (_e, chatId: number) => {
    if (typeof chatId !== "number" || !Number.isFinite(chatId)) {
      return { session: null };
    }
    return { session: getWorkforceChatSession(chatId) ?? null };
  });

  ipcMain.handle("workforce:session:set-scope", (_e, chatId: number, scopeNote: string) => {
    if (typeof chatId !== "number" || !Number.isFinite(chatId)) {
      return { success: false };
    }
    setWorkforceChatSessionScope(chatId, String(scopeNote ?? ""));
    return { success: true };
  });

  ipcMain.handle("workforce:session:clear", (_e, chatId: number) => {
    if (typeof chatId !== "number" || !Number.isFinite(chatId)) {
      return { success: false };
    }
    clearWorkforceChatSession(chatId);
    return { success: true };
  });

  ipcMain.handle("workforce:session:complete-prompt", (_e, chatId: number, success: boolean) => {
    const w = scopeWaiters.get(chatId);
    if (w) {
      scopeWaiters.delete(chatId);
      w(Boolean(success));
    }
    return { success: true };
  });
}
