/**
 * IPC: workspace terminal command category permissions.
 */

import { ipcMain, type IpcMainInvokeEvent } from "electron";
import log from "electron-log";
import type { CommandPermissionDecision } from "@/lib/terminal-command-category";
import { getCommandCategory } from "@/lib/terminal-command-category";
import { isDangerousCommand, dangerLabelKey } from "@/lib/dangerous-commands";
import { isSystemScopeCommand } from "@/lib/system-scope-commands";
import { quoteAwareSegments } from "@/lib/command-segments";
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

/** Per-segment verdict + the store key that would flip it (for "always allow"). */
type SegmentVerdict = { state: "allow" | "deny" | "prompt"; key: string; dangerous: boolean };

/**
 * Classify ONE command segment. Reference model (Codex + Claude Code): the OS
 * sandbox is the enforcement boundary (read-only vs workspace-write per work mode),
 * so a plain command AUTO-RUNS — there is no read/mutate command taxonomy. We only
 * ASK for the always-on danger/outward backstop (`dangerous-commands.ts` — kept as
 * the sole small list, surfaced as a prompt) and honor the user's workspace rules.
 * Dangerous segments key on their fine-grained `danger:<id>` (a coarse "always
 * allow git" can never satisfy `git push --force`).
 */
function classifySegment(
  segment: string,
  appId: number | null | undefined,
): SegmentVerdict {
  if (isDangerousCommand(segment)) {
    const key = dangerLabelKey(segment) ?? getCommandCategory(segment);
    const decision = appId != null ? getWorkspaceCommandPermission(appId, key) : null;
    const state =
      decision === "always_deny" ? "deny" : decision === "always_allow" ? "allow" : "prompt";
    return { state, key, dangerous: true };
  }
  const key = getCommandCategory(segment);
  const decision = appId != null ? getWorkspaceCommandPermission(appId, key) : null;
  if (decision === "always_deny") return { state: "deny", key, dangerous: false };
  // Default: auto-run. The mode's OS sandbox contains it (read-only source in
  // Explore/Plan/Review; workspace-write in Build/Debug). A write the mode
  // disallows fails cleanly at the OS layer — never a pre-emptive dead-end.
  return { state: "allow", key, dangerous: false };
}

/**
 * Reference-grade per-segment gate (opencode / Claude Code model): split the
 * command into its pipeline/chain segments and require EVERY segment to be
 * allowed for it to auto-run. Any denied segment denies the whole command; a
 * system-scope command (on-device install / sudo / outside-workspace write —
 * detected with the REAL workspace root when available) never silently
 * auto-allows; otherwise the default is a prompt. The trust boundary remains the
 * OS write-sandbox + dangerous-gate; this only decides whether to skip the prompt.
 */
export function resolveRunCommandPermissionGate(
  command: string,
  appId: number | null | undefined,
  workspaceRoot?: string,
): RunCommandPermissionGate {
  const segments = quoteAwareSegments(command);
  // Unparseable (substitution in double quotes / unbalanced quotes) or empty →
  // fail safe to a prompt with a coarse category label.
  if (!segments || segments.length === 0) {
    return { action: "prompt", category: getCommandCategory(command), dangerous: isDangerousCommand(command) };
  }

  const verdicts = segments.map((seg) => classifySegment(seg, appId));
  const anyDangerous = verdicts.some((v) => v.dangerous);

  // Deny wins: any denied segment blocks the whole command.
  const denied = verdicts.find((v) => v.state === "deny");
  if (denied) return { action: "auto_deny", category: denied.key };

  // System-scope (real root when threaded through) is never silently auto-allowed.
  const systemScope = isSystemScopeCommand(command, workspaceRoot ?? "");
  const firstBlocking = verdicts.find((v) => v.state === "prompt");

  if (systemScope) {
    return {
      action: "prompt",
      category: firstBlocking?.key ?? verdicts[0]!.key,
      dangerous: anyDangerous,
    };
  }
  if (!firstBlocking) {
    // Every segment allowed → auto-run, no prompt.
    return { action: "auto_allow", category: verdicts[0]!.key };
  }
  // At least one segment needs approval → prompt, keyed to the first blocker so
  // "always allow" saves the rule that unblocks the command.
  return { action: "prompt", category: firstBlocking.key, dangerous: anyDangerous };
}

export type RunCommandCategoryPreflight =
  | { type: "auto_allow"; category: string }
  | { type: "auto_deny"; category: string }
  | { type: "prompt"; category: string; dangerous: boolean };

export function runCommandCategoryPreflight(
  command: string,
  appId: number | null | undefined,
  workspaceRoot?: string,
): RunCommandCategoryPreflight {
  const gate = resolveRunCommandPermissionGate(command, appId, workspaceRoot);
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

  // No built-in read-only allow-set anymore: commands auto-run inside the OS
  // sandbox (read-only in Explore/Plan/Review, workspace-write in Build/Debug);
  // only the danger backstop + user rules gate. Kept as an empty list so the
  // Settings UI + any renderer caller keep working.
  ipcMain.handle("command-permissions:defaults", () => []);

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
