/**
 * IPC: workspace terminal command category permissions.
 */

import { ipcMain, type IpcMainInvokeEvent } from "electron";
import log from "electron-log";
import type { CommandPermissionDecision } from "@/lib/terminal-command-category";
import { getCommandCategory } from "@/lib/terminal-command-category";
import { isDangerousCommand, dangerLabelKey } from "@/lib/dangerous-commands";
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
  const dangerous = isDangerousCommand(command);
  // The permission-store key: the fine-grained `danger:<id>` key for dangerous
  // commands (so a coarse first-token allow can't satisfy them), else the
  // first-token category. This key is also what an always-allow persists under
  // and what the UI shows as the rule label.
  const category = dangerous
    ? (dangerLabelKey(command) ?? getCommandCategory(command))
    : getCommandCategory(command);

  // A dangerous command with no workspace decision yet ALWAYS prompts — never
  // auto-allowed, even in autonomous mode. Only an explicit always-allow (keyed
  // by its danger key) lets it run without a prompt; the user can revoke it in
  // Settings. This is the safety invariant that replaces the old hard-floor
  // throw (which was an unsatisfiable dead-end in autonomous mode).
  if (appId == null) {
    return { action: "prompt", category, dangerous };
  }

  const decision = getWorkspaceCommandPermission(appId, category);
  if (decision === "always_allow") {
    return { action: "auto_allow", category };
  }
  if (decision === "always_deny") {
    return { action: "auto_deny", category };
  }

  return { action: "prompt", category, dangerous };
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
      // A `danger:` key is already the canonical permission key — persist it as
      // given. Everything else normalizes to its first-token category. Dangerous
      // commands can now be always-allowed (revocable in Settings); the safety
      // guarantee is that they can never be *silently* auto-approved until such a
      // rule exists (see resolveRunCommandPermissionGate).
      const raw = category.trim();
      const cat = raw.startsWith("danger:")
        ? raw
        : getCommandCategory(raw) || raw.toLowerCase();
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
