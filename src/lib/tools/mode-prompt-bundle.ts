/**
 * Active-mode prompt bundle — current mode header, behavior, tools_registry.
 * No other work modes named in prose (per-turn scope only).
 */

import type { ModeRegistryKey } from "./mode-tool-registry";
import {
  renderActiveModeToolsRegistry,
  type RenderActiveModeToolsRegistryOptions,
} from "./mode-tool-registry";
import { ATLARIX_GIT_AUTHOR_EMAIL } from "@/ipc/utils/git_author";

export const GIT_VIA_TERMINAL_NOTE =
  "Git operations should use the **run_command** tool with standard git CLI (git status, git log, git diff, git show). Do not parse .git/objects manually when run_command can answer.";

/** Git note plus per-stream commit-author guidance (commit-capable modes only). */
export function getGitTerminalNote(gitAuthorName?: string): string {
  if (!gitAuthorName) return GIT_VIA_TERMINAL_NOTE;
  return `${GIT_VIA_TERMINAL_NOTE}
When you create git commits, author them as the agent: \`git commit --author="${gitAuthorName} <${ATLARIX_GIT_AUTHOR_EMAIL}>" -m "..."\`. Never change the user's git config. Keep any Co-authored-by trailer behavior unchanged.`;
}

/** ## Current mode: {label} + CAN/CANNOT (active mode only). */
export function getActiveModeHeaderBlock(mode: ModeRegistryKey): string {
  const blocks: Record<ModeRegistryKey, string> = {
    ask: `## Current mode: Explore

You are in Explore mode. This is a read-only investigation mode for this chat turn.

You CAN:
- Read files and search the codebase
- Use **run_command** for read-only shell/git (git status, git log, git diff, ls, cat)
- Use get_blueprint, search, web_search / deep_research (one per topic per turn)
- Answer questions and use attachments (read_attachment, list_attachments)

You CANNOT:
- Write or edit files or use write_implementation_plan
- Run mutating commands via run_command (npm install, git commit, rm, etc.)

Do not claim run_command is unavailable. For git history/status, call run_command instead of reading .git/objects.

If the user needs file changes or implementation, tell them to change work mode in the UI — not available in this mode.`,

    plan: `## Current mode: Plan

You are in Plan mode. Planning and architecture for this chat turn.

You CAN:
- Read and search the codebase; run_command for read-only git/shell
- write_implementation_plan, read_implementation_plan, update_plan_status
- write_file / edit_file only for .atlarix/atlarix.md and .atlarix/memory.md
- get_blueprint and session plan tools

You CANNOT:
- Edit application source code or run build/install commands

If the user wants code implementation, tell them to change work mode in the UI.`,

    build: `## Current mode: Build

You are in Build mode. Full implementation for this chat turn.

You CAN:
- Read and write files (approval queue for mutating operations)
- run_command, all workspace tools via progressive reveal
- Delegate to specialist agents when appropriate

Focus on correct, complete implementation. File writes queue automatically — do not ask the user to approve each write.

Plan lifecycle: when an active session plan appears in context (it includes its planId and status), call update_plan_status(planId, "building") before implementing it and update_plan_status(planId, "built") once the implementation satisfies the plan. Mark individual checklist steps with update_plan_step as you start ("in_progress") and finish ("done") each one.`,

    debug: `## Current mode: Debug

You are in Debug mode. Hypothesis-first debugging for this chat turn.

You CAN:
- Investigate (read, search, LSP, diagnose_issue, run_command for repro/tests)
- **record_debug_hypothesis** before any write/edit/delete/rename
- Minimal file changes that test the recorded hypothesis only

You CANNOT:
- Change files before recording a hypothesis
- Refactor unrelated code or add features

Workflow: investigate → record_debug_hypothesis → minimal fix → lsp_diagnostics / tests → revise hypothesis if needed.`,

    review: `## Current mode: Review

You are in Review mode. Read-only quality review for this chat turn.

You CAN:
- Read files, search, run_command for read-only git/tests output
- LSP tools for findings; delegate for structured review when helpful

You CANNOT:
- Write or edit source files or run mutating commands

Produce specific, actionable feedback.`,
  };
  return blocks[mode] ?? blocks.ask;
}

/** Extra behavior without duplicating the header (no other mode names). */
function getActiveModeWorkExtras(mode: ModeRegistryKey): string {
  switch (mode) {
    case "ask":
      return `<work_mode>
Discovery: explore_folder / list_files on paths tied to the question; get_repo_overview with focus_path for large trees (avoid workspace root unless needed).
search (auto | text | semantic | structural) → get_file_outline → read_file for exact ranges.
get_blueprint requires focus_path. At most 5 spawn_sub_agent calls per turn when batching scopes.
Do not use write_file, edit_file, write_implementation_plan, or mutating run_command.
</work_mode>`;
    case "plan":
      return `<work_mode>
Session plans live in write_implementation_plan (not on-disk roadmap files). Read read_implementation_plan before revising. After saving, include the returned marker comment in your reply so the UI shows a plan card. write_file / edit_file are for .atlarix docs only: atlarix.md (durable project instructions) and memory.md (project knowledge: stack, architecture, layout).
</work_mode>`;
    case "build":
      return `<work_mode>
Use native function tools for operations. Project files belong at workspace root, not under .atlarix/ unless asked.
After edit_file / write_file, call lsp_diagnostics on touched paths when LSP is available.
One run_command for scaffolding when creating projects. Prefer write_file under ~500 lines per call.
If implementing an active session plan (see its planId in context), call update_plan_status(planId, "building") first and update_plan_status(planId, "built") when the plan is fully implemented.
Live step progress: as you START each plan checklist step call update_plan_step(planId, step_index, "in_progress"), and "done" when that step is finished — the plan card updates live for the user.
When fully done and verified: <task_complete>Task finished successfully</task_complete> (only if tests pass and nothing blocks progress).
</work_mode>`;
    case "debug":
      return `<work_mode>
Gated writes: record_debug_hypothesis first, then minimal edits aligned to that hypothesis only.
</work_mode>`;
    case "review":
      return `<work_mode>
Read-only review; cite files and concrete issues. No source mutations.
</work_mode>`;
    default:
      return "";
  }
}

export type RenderModePromptBundleOptions = RenderActiveModeToolsRegistryOptions & {
  /** "<Model> agent" author name for git commit guidance (Build/Debug only). */
  gitAuthorName?: string;
};

/** Single active-mode block: header + work_mode + tools_registry + git note. */
export function renderModePromptBundle(
  mode: ModeRegistryKey,
  opts?: RenderModePromptBundleOptions,
): string {
  const canCommit = mode === "build" || mode === "debug";
  return [
    getActiveModeHeaderBlock(mode),
    getActiveModeWorkExtras(mode),
    renderActiveModeToolsRegistry(mode, opts),
    canCommit ? getGitTerminalNote(opts?.gitAuthorName) : GIT_VIA_TERMINAL_NOTE,
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
}

/** Tools that imply web research rules in the stable header. */
export function modeAllowlistIncludesWebResearch(mode: ModeRegistryKey): boolean {
  return mode === "ask" || mode === "build" || mode === "plan";
}

/** Tools that imply inline visual artifact guidance. */
export function modeAllowlistIncludesVisualTools(mode: ModeRegistryKey): boolean {
  return (
    mode === "ask" ||
    mode === "build" ||
    mode === "plan" ||
    mode === "debug" ||
    mode === "review"
  );
}
