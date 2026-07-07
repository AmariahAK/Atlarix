/**
 * run_command / file permission gating + UI enrichment helpers extracted from
 * chat_stream_handlers.ts. Pure leaves — no module state, safe to import from
 * anywhere. (Satellite: never imports the parent handler — keeps the
 * run-agent-turn cycle-avoidance intact.)
 */

import log from "electron-log";
import type { WorkMode } from "@/lib/schemas";
import { WorkModeSchema } from "@/lib/schemas";
import { isMutatingCommand } from "@/lib/command-mutation";
import { labelForWorkMode } from "@/lib/work-mode";
import { runCommandGitInitGateResult } from "@/lib/git-init-command-guard";
import { readSettings } from "@/main/settings";
import { safeSend } from "@/ipc/utils/safe_sender";
import { enrichFilePermissionRequest } from "../file_permission_preflight";
import { runCommandCategoryPreflight } from "../command_permission_handlers";

const logger = log.scope("chat_stream_handlers");

export function runCommandModeGateResult(
  command: string,
  workMode: WorkMode,
): string | null {
  // v14 pt3: read-only modes (Explore/Plan/Review) may run NON-mutating commands
  // (reads, dev servers, builds, tests, installs, curl GET) — only clearly
  // mutating/destructive commands are blocked. Build/Debug authorize mutation.
  // Compound-aware (fixes the old `cd x && git push` bypass + `npm run dev`
  // mis-block). The dangerous gate + .atlarix rules are enforced separately.
  if (!isMutatingCommand(command)) return null;
  if (workMode === "build" || workMode === "debug") return null;
  return JSON.stringify({
    success: false,
    error: `Blocked by MODE, not by permissions: "${command}" changes the workspace/repo, and the current ${labelForWorkMode(workMode)} mode is read-only for the source. This is NOT an approval prompt — retrying this command or asking for approval will not help while the mode is unchanged (a previous mode may have allowed it; this one does not). Do exactly one of: run a non-mutating alternative (reads, dev servers, builds, tests, installs are fine here), or call ask_user to have the user switch to Build/Debug — then STOP retrying this command.`,
  });
}

export function runCommandGateResult(command: string, workMode: WorkMode): string | null {
  // v12 3.6: fail-closed on an invalid workMode — runtime values flow in from
  // persisted settings / IPC, so don't trust the static type at this gate.
  if (!WorkModeSchema.safeParse(workMode).success) {
    logger.warn(
      `[run-command gate] invalid workMode ${JSON.stringify(workMode)} — failing closed`,
    );
    return JSON.stringify({
      success: false,
      error:
        "Command blocked: the active work mode could not be determined. Switch modes in the UI and retry.",
    });
  }
  const gitInitBlock = runCommandGitInitGateResult(
    command,
    readSettings().allowGitInit,
  );
  if (gitInitBlock) return gitInitBlock;
  return runCommandModeGateResult(command, workMode);
}

export function emitRunCommandPermissionActivity(
  sender: Electron.WebContents,
  chatId: number,
  label: string,
  command: string,
) {
  safeSend(sender, "chat:activity", {
    id: `run-cmd-perm-${chatId}-${Date.now()}`,
    type: "tool_use",
    toolName: "run_command",
    label,
    detail: command.slice(0, 200),
    status: "done",
    timestamp: Date.now(),
    chatId,
  });
}

export function emitFilePermissionActivity(
  sender: Electron.WebContents,
  chatId: number,
  label: string,
  path: string,
) {
  safeSend(sender, "chat:activity", {
    id: `file-perm-${chatId}-${Date.now()}`,
    type: "tool_use",
    // v13.8: edit_file is the single file-mutation tool (absorbed write_file).
    toolName: "edit_file",
    label,
    detail: path.slice(0, 200),
    status: "done",
    timestamp: Date.now(),
    chatId,
  });
}

export function enrichPermissionRequestForUi(
  permRequest: { operation: string; preview: unknown },
  appId: number | null | undefined,
) {
  if (permRequest.operation === "run_command") {
    return enrichRunCommandPermissionRequest(permRequest, appId);
  }
  return enrichFilePermissionRequest(permRequest as import("@/lib/tools/permissions/schema").PermissionRequest, appId);
}

/**
 * Display-only overwrite preview for AUTO-APPROVED writes.
 *
 * A manually-approved write reaches the renderer via the `permission-request`
 * preview (which carries the uncapped old/new content), so its completed card
 * renders an accurate red/green diff. An auto-approved write ("always allow"
 * this file/dir, or a fully autonomous Build turn) skips that preview entirely,
 * so the renderer never learns the old content and the card falls back to
 * all-added. This pushes the same old/new content over a display-only channel
 * so the auto-approved card is just as accurate.
 *
 * This is NEVER sent to the model — it only lands in the display snapshot
 * (zero model tokens; the model result still carries only line counts).
 */
export function emitAutoApprovedWritePreview(
  sender: Electron.WebContents | null | undefined,
  chatId: number,
  operation: string,
  execResult: {
    path?: string;
    operation?: string;
    oldContent?: string;
    newContent?: string;
  },
): void {
  if (operation !== "write_file" && operation !== "edit_file") return;
  if (!execResult.path) return;
  if (typeof execResult.newContent !== "string" && typeof execResult.oldContent !== "string") {
    return;
  }
  safeSend(sender, "chat:stream:write-preview", {
    chatId,
    path: execResult.path,
    operation: execResult.operation ?? "update",
    oldContent: execResult.oldContent ?? "",
    content: execResult.newContent ?? "",
  });
}

/** Category DB gate for run_command; returns tool JSON to return early, or null to continue permission UI. */
export function runCommandCategoryGateToolResult(
  command: string,
  appId: number | null | undefined,
  chatId: number,
  sender: Electron.WebContents,
): string | null {
  const preflight = runCommandCategoryPreflight(command, appId);
  if (preflight.type === "auto_deny") {
    emitRunCommandPermissionActivity(
      sender,
      chatId,
      `run_command blocked (${preflight.category})`,
      command,
    );
    safeSend(sender, "command-permission-blocked", {
      chatId,
      category: preflight.category,
      message: `Command blocked (${preflight.category}) — change in Settings`,
    });
    return JSON.stringify({
      success: false,
      error: `Command blocked by workspace policy (${preflight.category}). Update Terminal permissions in Settings.`,
      operation: "run_command",
    });
  }
  return null;
}

export function shouldSkipPermissionWaitForRunCommand(
  command: string,
  appId: number | null | undefined,
  chatId: number,
  sender: Electron.WebContents,
): boolean {
  const preflight = runCommandCategoryPreflight(command, appId);
  if (preflight.type === "auto_allow") {
    emitRunCommandPermissionActivity(
      sender,
      chatId,
      `run_command auto-approved (${preflight.category})`,
      command,
    );
    return true;
  }
  return false;
}

export function enrichRunCommandPermissionRequest<T extends { operation: string; preview: unknown }>(
  permRequest: T,
  appId: number | null | undefined,
): T {
  if (permRequest.operation !== "run_command") return permRequest;
  const preview = permRequest.preview as { command?: string; isDangerous?: boolean };
  const preflight = runCommandCategoryPreflight(preview.command ?? "", appId);
  const dangerous =
    preflight.type === "prompt" ? preflight.dangerous : false;
  return {
    ...permRequest,
    preview: {
      ...preview,
      // For a dangerous command this is the fine-grained `danger:<id>` key,
      // which is both the always-allow persist key and the UI rule label.
      commandCategory: preflight.category,
      isDangerous: dangerous || preview.isDangerous,
      // Dangerous commands can now be always-allowed too (the badge is
      // informational, not a blocker). Only a resolved auto_allow/deny (no
      // longer "prompt") hides the button.
      canAlwaysAllow: preflight.type === "prompt",
    },
  } as T;
}
