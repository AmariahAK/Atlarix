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
import { mutationLabelKey } from "@/lib/mutating-commands";
import {
  getWorkspaceCommandPermission,
  listWorkspaceCommandPermissions,
  revokeWorkspaceCommandPermission,
  upsertWorkspaceCommandPermission,
} from "@/lib/command-permissions-store";

const logger = log.scope("command-permissions");

/**
 * Why a command is being shown to a human. NOT a fourth outcome — the outcome is
 * still `prompt`; this only lets the card say what kind of prompt it is, and it
 * keeps `reason` from being re-derived by every consumer.
 */
export type PromptReason = "rule" | "danger" | "mutation";

export type RunCommandPermissionGate =
  | { action: "auto_allow"; category: string }
  | { action: "auto_deny"; category: string }
  | {
      action: "prompt";
      category: string;
      dangerous: boolean;
      reason: PromptReason;
    };

/** Per-segment verdict + the store key that would flip it (for "always allow"). */
type SegmentVerdict = {
  state: "allow" | "deny" | "prompt";
  key: string;
  dangerous: boolean;
  reason: PromptReason;
};

/**
 * Classify ONE command segment.
 *
 * A plain command AUTO-RUNS. Three things can stop it, and each keys its
 * always-allow rule under its own prefix so allowing one never allows another:
 *
 *  1. `danger:<id>`  — the always-on destructive/outward backstop
 *                      (`dangerous-commands.ts`). Every mode, always.
 *  2. `mutate:<id>`  — source mutation in a mode that does not authorize it
 *                      (`mutating-commands.ts`). Read-only callers only.
 *  3. the coarse first-token category — the user's own workspace rules.
 *
 * (2) is the reference model — Claude Code's plan mode classifies the command
 * and prompts; Codex and Cursor make the workspace writable and protect
 * `.git`. What it replaced was an OS sandbox that dropped the workspace from
 * the writable set, which enforced "no source edits" by also breaking vitest,
 * `npm install`, every build and every dev server — all of which the mode
 * prompts said worked.
 */
function classifySegment(
  segment: string,
  appId: number | null | undefined,
  readOnlySource: boolean,
): SegmentVerdict {
  if (isDangerousCommand(segment)) {
    const key = dangerLabelKey(segment) ?? getCommandCategory(segment);
    const decision =
      appId != null ? getWorkspaceCommandPermission(appId, key) : null;
    const state =
      decision === "always_deny"
        ? "deny"
        : decision === "always_allow"
          ? "allow"
          : "prompt";
    return { state, key, dangerous: true, reason: "danger" };
  }
  const key = getCommandCategory(segment);
  const decision =
    appId != null ? getWorkspaceCommandPermission(appId, key) : null;
  if (decision === "always_deny")
    return { state: "deny", key, dangerous: false, reason: "rule" };

  // Source mutation, in a mode that does not authorize it.
  //
  // ORDER IS LOAD-BEARING. After the danger branch, so `rm -rf /` still keys on
  // `danger:rm-rf` and keeps its amber badge rather than being downgraded to a
  // mutation. After the coarse rule lookup, so an explicit `always_deny` still
  // wins. Before the default-allow, which is the branch it exists to intercept.
  //
  // This is the layer that used to be the OS sandbox. Read-only modes now run
  // with a WRITABLE workspace — otherwise vitest, installs, builds and dev
  // servers all fail, which is what the mode prompts were promising and the
  // filesystem was refusing. So "don't change the source" moves here, which is
  // where Claude Code, Codex and Cursor all enforce it.
  if (readOnlySource) {
    const mutateKey = mutationLabelKey(segment);
    if (mutateKey) {
      const mutateDecision =
        appId != null ? getWorkspaceCommandPermission(appId, mutateKey) : null;
      if (mutateDecision !== "always_allow") {
        return {
          state: mutateDecision === "always_deny" ? "deny" : "prompt",
          key: mutateKey,
          dangerous: false,
          reason: "mutation",
        };
      }
    }
  }

  // Default: auto-run, and the DENY-LIST shape above is what makes that safe to
  // say. Nothing enumerates reads, builds, installs or test runners — they run
  // because no write-shaped pattern matched them.
  return { state: "allow", key, dangerous: false, reason: "rule" };
}

/**
 * Reference-grade per-segment gate (opencode / Claude Code model): split the
 * command into its pipeline/chain segments and require EVERY segment to be
 * allowed for it to auto-run. Any denied segment denies the whole command; a
 * system-scope command (on-device install / sudo / outside-workspace write —
 * detected with the REAL workspace root when available) never silently
 * auto-allows; otherwise the default is a prompt.
 *
 * `readOnlySource` says this caller's turn does not authorize source mutation
 * (Explore / Plan / Review, and every sub-agent command). It is a POLICY, not a
 * mode: the sub-agent call site has no work mode at all, only
 * `preview.readOnly`, and passing a fabricated `"review"` there would be a lie a
 * future reader has to decode. Optional with a `false` default so Build/Debug
 * semantics — and the existing corpus of tests written against them — are
 * unchanged by construction rather than by assertion.
 */
export function resolveRunCommandPermissionGate(
  command: string,
  appId: number | null | undefined,
  workspaceRoot?: string,
  readOnlySource = false,
): RunCommandPermissionGate {
  const segments = quoteAwareSegments(command);
  // Unparseable (substitution in double quotes / unbalanced quotes) or empty →
  // fail safe to a prompt with a coarse category label.
  if (!segments || segments.length === 0) {
    return {
      action: "prompt",
      category: getCommandCategory(command),
      dangerous: isDangerousCommand(command),
      reason: "rule",
    };
  }

  const verdicts = segments.map((seg) =>
    classifySegment(seg, appId, readOnlySource),
  );
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
      reason: firstBlocking?.reason ?? "rule",
    };
  }
  if (!firstBlocking) {
    // Every segment allowed → auto-run, no prompt.
    return { action: "auto_allow", category: verdicts[0]!.key };
  }
  // At least one segment needs approval → prompt, keyed to the first blocker so
  // "always allow" saves the rule that unblocks the command.
  return {
    action: "prompt",
    category: firstBlocking.key,
    dangerous: anyDangerous,
    reason: firstBlocking.reason,
  };
}

export type RunCommandCategoryPreflight =
  | { type: "auto_allow"; category: string }
  | { type: "auto_deny"; category: string }
  | {
      type: "prompt";
      category: string;
      dangerous: boolean;
      reason: PromptReason;
    };

/**
 * `readOnlySource` is REQUIRED here, unlike on the gate below it, and that
 * asymmetry is deliberate: this function has a small, enumerable set of
 * production call sites, so making it required turns "did every caller get
 * updated?" into a compiler question instead of a review question.
 */
export function runCommandCategoryPreflight(
  command: string,
  appId: number | null | undefined,
  workspaceRoot: string | undefined,
  readOnlySource: boolean,
): RunCommandCategoryPreflight {
  const gate = resolveRunCommandPermissionGate(
    command,
    appId,
    workspaceRoot,
    readOnlySource,
  );
  if (gate.action === "auto_allow") {
    return { type: "auto_allow", category: gate.category };
  }
  if (gate.action === "auto_deny") {
    return { type: "auto_deny", category: gate.category };
  }
  return {
    type: "prompt",
    category: gate.category,
    dangerous: gate.dangerous,
    reason: gate.reason,
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
      try {
        upsertWorkspaceCommandPermission(appId, cat, decision);
      } catch (e) {
        // Degrade instead of throwing raw SqliteError out of IPC (e.g. disk full
        // → the rollback journal can't be created). The renderer gets a clean
        // failure it can surface, not an unhandled rejection.
        logger.warn(
          `[command-permissions] upsert failed app=${appId} cat=${cat}:`,
          e,
        );
        return {
          success: false,
          error: "Couldn't save permission (storage may be full).",
        };
      }
      logger.log(
        `[command-permissions] upsert app=${appId} cat=${cat} decision=${decision}`,
      );
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
