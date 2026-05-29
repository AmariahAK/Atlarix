/**
 * IPC: workspace terminal command category permissions.
 */

import { ipcMain, type IpcMainInvokeEvent } from "electron";
import log from "electron-log";
import type { CommandPermissionDecision } from "@/lib/terminal-command-category";
import {
  getCommandCategory,
  isDangerousCategory,
} from "@/lib/terminal-command-category";
import {
  getWorkspaceCommandPermission,
  listWorkspaceCommandPermissions,
  revokeWorkspaceCommandPermission,
  upsertWorkspaceCommandPermission,
} from "@/lib/command-permissions-store";

const logger = log.scope("command-permissions");

export type RunCommandPermissionGate =
  | { action: "auto_allow"; category: string }
  | { action: "auto_deny"; category: string }
  | { action: "prompt"; category: string; dangerous: boolean };

export function resolveRunCommandPermissionGate(
  command: string,
  appId: number | null | undefined,
): RunCommandPermissionGate {
  const category = getCommandCategory(command);
  const dangerous = isDangerousCategory(category);

  if (dangerous) {
    return { action: "prompt", category, dangerous: true };
  }

  if (appId == null) {
    return { action: "prompt", category, dangerous: false };
  }

  const decision = getWorkspaceCommandPermission(appId, category);
  if (decision === "always_allow") {
    return { action: "auto_allow", category };
  }
  if (decision === "always_deny") {
    return { action: "auto_deny", category };
  }

  return { action: "prompt", category, dangerous: false };
}

export type RunCommandCategoryPreflight =
  | { type: "auto_allow"; category: string }
  | { type: "auto_deny"; category: string }
  | { type: "prompt"; category: string; dangerous: boolean };

export function runCommandCategoryPreflight(
  command: string,
  appId: number | null | undefined,
): RunCommandCategoryPreflight {
  const gate = resolveRunCommandPermissionGate(command, appId);
  if (gate.action === "auto_allow") {
    return { type: "auto_allow", category: gate.category };
  }
  if (gate.action === "auto_deny") {
    return { type: "auto_deny", category: gate.category };
  }
  return {
    type: "prompt",
    category: gate.category,
    dangerous: gate.action === "prompt" ? gate.dangerous : false,
  };
}

export function registerCommandPermissionHandlers(): void {
  ipcMain.handle(
    "command-permissions:list",
    (_event: IpcMainInvokeEvent, { appId }: { appId: number }) => {
      if (!appId) return [];
      return listWorkspaceCommandPermissions(appId);
    },
  );

  ipcMain.handle(
    "command-permissions:upsert",
    (
      _event: IpcMainInvokeEvent,
      {
        appId,
        category,
        decision,
      }: {
        appId: number;
        category: string;
        decision: CommandPermissionDecision;
      },
    ) => {
      if (!appId || !category?.trim()) {
        return { success: false, error: "Invalid appId or category" };
      }
      const cat = getCommandCategory(category) || category.trim().toLowerCase();
      if (isDangerousCategory(cat)) {
        return {
          success: false,
          error: "Dangerous command categories cannot be saved as always allow",
        };
      }
      upsertWorkspaceCommandPermission(appId, cat, decision);
      logger.log(`[command-permissions] upsert app=${appId} cat=${cat} decision=${decision}`);
      return { success: true };
    },
  );

  ipcMain.handle(
    "command-permissions:revoke",
    (
      _event: IpcMainInvokeEvent,
      { appId, category }: { appId: number; category: string },
    ) => {
      if (!appId || !category?.trim()) {
        return { success: false };
      }
      const removed = revokeWorkspaceCommandPermission(appId, category);
      return { success: removed };
    },
  );
}
