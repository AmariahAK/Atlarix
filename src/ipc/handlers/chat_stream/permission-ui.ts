/**
 * run_command / file permission gating + UI enrichment helpers extracted from
 * chat_stream_handlers.ts. Pure leaves — no module state, safe to import from
 * anywhere. (Satellite: never imports the parent handler — keeps the
 * run-agent-turn cycle-avoidance intact.)
 */

import log from "electron-log";
import type { WorkMode } from "@/lib/schemas";
import { WorkModeSchema } from "@/lib/schemas";
import { safeSend } from "@/ipc/utils/safe_sender";
import { computeDiffHunks, type DiffHunk } from "@/lib/diff/compose-hunks";
import { enrichFilePermissionRequest } from "../file_permission_preflight";
import { runCommandCategoryPreflight } from "../command_permission_handlers";
import {
  isSystemScopeCommand,
  getSystemScopeExplanation,
} from "@/lib/system-scope-commands";
import {
  firstMutatingSegment,
  getMutationExplanation,
} from "@/lib/mutating-commands";

const logger = log.scope("chat_stream_handlers");

/**
 * Command work-mode gate — the invalid-mode fail-close, and nothing else.
 *
 * Read-only enforcement for Explore/Plan/Review lives in
 * `classifySegment` (command_permission_handlers.ts), which routes a
 * write-shaped command to the approval queue. It deliberately does NOT live
 * here: this function has no notion of approval, and overloading it with one is
 * how the previous design got muddy — its ancestor hard-BLOCKED mutating
 * commands, which is why a model could be told to stop retrying but never told
 * it could simply ask.
 *
 * It also no longer lives in the OS sandbox. Read-only modes run with a writable
 * workspace now, because the strict profile broke vitest, installs, builds and
 * dev servers — everything the mode prompts promised.
 */
export function runCommandGateResult(
  _command: string,
  workMode: WorkMode,
): string | null {
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
  return null;
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
  workspaceRoot: string | undefined,
  readOnlySource: boolean,
) {
  if (permRequest.operation === "run_command") {
    return enrichRunCommandPermissionRequest(
      permRequest,
      appId,
      workspaceRoot,
      readOnlySource,
    );
  }
  return enrichFilePermissionRequest(
    permRequest as import("@/lib/tools/permissions/schema").PermissionRequest,
    appId,
  );
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
  if (
    typeof execResult.newContent !== "string" &&
    typeof execResult.oldContent !== "string"
  ) {
    return;
  }
  const oldContent = execResult.oldContent ?? "";
  const newContent = execResult.newContent ?? "";

  // Diff HERE, not in the renderer.
  //
  // `computeDiffHunks` runs a Myers diff over the whole file. It used to run
  // inside a `useMemo` in SmartDiffView — synchronously, during React render,
  // on the UI thread — so a ~1000-line write froze the app for about five
  // seconds, and worse than linearly beyond that. Main already holds both
  // bodies right here, so it can pay that cost once, off the UI thread.
  //
  // The counts matter as much as the hunks: with them the COLLAPSED view needs
  // no diff work in the renderer at all, which is what makes collapsing large
  // diffs by default free.
  //
  // The bodies still ship. `composeContentFromHunks` rebuilds a
  // partially-accepted file in the renderer and needs them; moving that to main
  // would let us drop them, but it changes a contract carrying user approval
  // intent and the CPU win doesn't depend on it.
  let hunks: DiffHunk[] = [];
  let addedCount = 0;
  let removedCount = 0;
  try {
    hunks = computeDiffHunks(oldContent, newContent);
    for (const h of hunks) {
      addedCount += h.addedCount;
      removedCount += h.removedCount;
    }
  } catch {
    // Display-only: a diff we can't compute must never break the write itself.
    // The renderer falls back to computing locally when `hunks` is absent.
    hunks = [];
  }

  safeSend(sender, "chat:stream:write-preview", {
    chatId,
    path: execResult.path,
    operation: execResult.operation ?? "update",
    oldContent,
    content: newContent,
    ...(hunks.length > 0 ? { hunks, addedCount, removedCount } : {}),
  });
}

/** Category DB gate for run_command; returns tool JSON to return early, or null to continue permission UI. */
export function runCommandCategoryGateToolResult(
  command: string,
  appId: number | null | undefined,
  chatId: number,
  sender: Electron.WebContents,
  workspaceRoot: string | undefined,
  readOnlySource: boolean,
): string | null {
  const preflight = runCommandCategoryPreflight(
    command,
    appId,
    workspaceRoot,
    readOnlySource,
  );
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
  workspaceRoot: string | undefined,
  readOnlySource: boolean,
): boolean {
  const preflight = runCommandCategoryPreflight(
    command,
    appId,
    workspaceRoot,
    readOnlySource,
  );
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

/**
 * A guessed edit always faces a human.
 *
 * `edit_file` carries a `preview.notice` when its match cascade landed the
 * region via a NON-exact strategy — indentation tolerance, escape
 * normalization, block anchoring. That notice is the tool stating it guessed,
 * and a guess is exactly what should not be committed unattended: on
 * 2026-07-28 an escape-normalized match auto-executed and wrote literal `\"`
 * into Go raw strings, with its only warning consumed by nobody.
 *
 * Returns true when the operation must NOT bypass the approval wait, whatever
 * the auto-approve settings say. Exact matches (no notice) are unaffected, so
 * the common path keeps queueing writes without prompting. Two things outrank
 * it (owner, 15.11.1; see `shouldSkipPermissionWait`): "Allow all this turn",
 * and a write into the agent-memory folder.
 *
 * Safe unattended: headless turns don't stall on this. `src/headless/auto-approve.ts`
 * polls buffered `permission-request` events and resolves them through the real
 * `execute-permission` handler, so a fuzzy edit is approved there rather than
 * waiting on a human who doesn't exist.
 */
export function requiresHumanReviewDespiteAutoApprove(permRequest: {
  operation: string;
  preview: unknown;
}): boolean {
  if (permRequest.operation !== "edit_file") return false;
  const notice = (permRequest.preview as { notice?: unknown } | null)?.notice;
  return typeof notice === "string" && notice.trim().length > 0;
}

/**
 * Whether an operation runs without waiting for a human. A guessed edit waits
 * whatever the auto-approve settings say, except where the user already said
 * yes to the whole turn ("Allow all this turn") or it writes the agent's memory
 * folder (`reviewOverridden`, from the interceptor): ai-c8's fuzzy edit asked
 * again right after "Allow all this turn" (15.11.0).
 */
export function shouldSkipPermissionWait(
  permRequest: { operation: string; preview: unknown },
  o: { reviewOverridden: boolean; autoApproved: boolean },
): boolean {
  if (o.reviewOverridden) return true;
  return !requiresHumanReviewDespiteAutoApprove(permRequest) && o.autoApproved;
}

/** What the model is told when it makes a change the user already denied this turn. */
export function deniedChangeResult(permRequest: { operation: string; preview: unknown }): string {
  const target = (permRequest.preview as { path?: string } | null)?.path ?? "that file";
  return JSON.stringify({
    success: false,
    error:
      `The user denied this exact change to ${target} earlier in this turn. Don't make it again, ` +
      "yourself or through a sub-agent; if it is still needed, ask the user first.",
    operation: permRequest.operation,
    path: target,
  });
}

export function enrichRunCommandPermissionRequest<
  T extends { operation: string; preview: unknown },
>(
  permRequest: T,
  appId: number | null | undefined,
  workspaceRoot: string | undefined,
  readOnlySource: boolean,
): T {
  if (permRequest.operation !== "run_command") return permRequest;
  const preview = permRequest.preview as {
    command?: string;
    isDangerous?: boolean;
    commandCategory?: string;
  };
  const preflight = runCommandCategoryPreflight(
    preview.command ?? "",
    appId,
    workspaceRoot,
    readOnlySource,
  );
  // Onto the STORED request too, not only the card: "always" saves the key from
  // the interceptor's copy (execute-permission), which had none, so it fell back
  // to the first word. In Explore that saved `npm` while the gate asks for
  // `mutate:package-manifest-write`, and the rule never covered a command (E6).
  preview.commandCategory = preflight.category;
  const dangerous = preflight.type === "prompt" ? preflight.dangerous : false;
  // System-scope = changes something OUTSIDE the project (on-device install, sudo,
  // outside-workspace write). A8/M-1: pass the REAL workspace root so the
  // outside-path branch (e.g. `echo x >> ~/.zshrc`) actually surfaces the
  // system-scope prompt — with an empty root it short-circuits to false and the
  // card wrongly renders an ordinary command while the interceptor runs it
  // unsandboxed. Falls back to "" (installer/sudo signals still fire) when the
  // root isn't threaded through.
  const root = workspaceRoot ?? "";
  const command = preview.command ?? "";
  const systemScope = isSystemScopeCommand(command, root);
  return {
    ...permRequest,
    preview: {
      ...preview,
      // For a dangerous command this is the fine-grained `danger:<id>` key,
      // which is both the always-allow persist key and the UI rule label.
      commandCategory: preflight.category,
      isDangerous: dangerous || preview.isDangerous,
      systemScope,
      systemScopeExplanation: systemScope
        ? getSystemScopeExplanation(command, root)
        : undefined,
      // Why this card exists, in the user's words.
      //
      // Without it a mutation card is indistinguishable from any other prompt:
      // the same shape appears for `git commit` and for `brew install`, and the
      // only visible difference is a category slug like `mutate:git-write`. The
      // card already does this for danger and for system scope; a mutation has
      // the same claim on an explanation, and more so — it is the newest reason
      // a command can stop, so it is the one a user has no prior for.
      mutationExplanation:
        preflight.type === "prompt" && preflight.reason === "mutation"
          ? getMutationExplanation(firstMutatingSegment(command) ?? command)
          : undefined,
      // Dangerous commands can now be always-allowed too (the badge is
      // informational, not a blocker). Only a resolved auto_allow/deny (no
      // longer "prompt") hides the button.
      canAlwaysAllow: preflight.type === "prompt",
    },
  } as T;
}
