/**
 * Extension space selection IPC — v4.0 Workforce
 * Per-workspace scope for Slack channels, Jira projects, etc.
 */

import { ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { getUserDataPath } from "../../paths/paths";

const FILENAME = "extension-space-selection.json";

type ScopePayload = Record<string, unknown>;

function getFilePath(): string {
  return path.join(getUserDataPath(), FILENAME);
}

function readStore(): Record<string, Record<string, ScopePayload>> {
  try {
    const p = getFilePath();
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf-8");
      const data = JSON.parse(raw) as Record<string, Record<string, ScopePayload>>;
      return data ?? {};
    }
  } catch {
    // ignore
  }
  return {};
}

function writeStore(store: Record<string, Record<string, ScopePayload>>): void {
  try {
    const p = getFilePath();
    fs.writeFileSync(p, JSON.stringify(store, null, 2), "utf-8");
  } catch (err) {
    console.error("[extension-space] write failed:", err);
  }
}

export function registerExtensionSpaceHandlers(): void {
  ipcMain.handle(
    "extensions:get-space-selection",
    (_event, workspaceId: number | string | null, service: string) => {
      const store = readStore();
      const key = String(workspaceId ?? "global");
      const serviceScope = store[key]?.[service];
      return { selection: serviceScope ?? null };
    }
  );

  ipcMain.handle(
    "extensions:set-space-selection",
    (_event, workspaceId: number | string | null, service: string, selection: ScopePayload | null) => {
      const store = readStore();
      const key = String(workspaceId ?? "global");
      if (!store[key]) store[key] = {};
      if (selection === null) {
        delete store[key][service];
      } else {
        store[key][service] = selection;
      }
      writeStore(store);
      return { success: true };
    }
  );

  ipcMain.handle("extensions:get-all-space-selections", (_event, workspaceId: number | string | null) => {
    const store = readStore();
    const key = String(workspaceId ?? "global");
    return { selections: store[key] ?? {} };
  });
}
