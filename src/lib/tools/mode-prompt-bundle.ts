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

/** Steers the model to cheap a11y refs before costly screenshots when using the in-app browser. */
export const BROWSER_NOTE =
  "Browser & preview: to read or interact with a page, call **browser_inspect** (mode:\"snapshot\" — a compact list of accessibility refs, cheap) before mode:\"screenshot\" (a costly image). Use the returned refs with **browser_interact** (action:\"click\"|\"fill\"). " +
  "Add **target:\"preview\"** to any of these (and to **browser_navigate**) to drive the LIVE PREVIEW of the app you are building — open routes, fill forms, click buttons, and verify the running UI. Use **browser_inspect(target:\"preview\", mode:\"console\")** to read the preview's runtime errors. Without target, the tools act on the in-app browser (target:\"browser\"). " +
  "To VERIFY a web UI change before finishing, prefer **preview_test** — one call runs a scripted, headless navigate→click/fill→waitFor→assert sequence against the live preview and returns a single pass/fail plus any runtime console errors and failed (4xx/5xx) requests. The turn will not be allowed to finish while the preview is throwing runtime errors, so fix and re-run preview_test until it passes.";

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

You are in Explore mode. This is a read-only investigation mode for this chat turn — read-only with respect to the SOURCE/repo, but you may run and observe the app.

You CAN:
- Read files and search the codebase with glob / grep (grep results are relevance-ranked)
- Run **non-mutating** commands with **run_command**: reads (ls, cat, git status/log/diff), tests, builds, **dependency installs** (npm/pip install), and curl/wget GET. These run automatically.
- RUN AND PREVIEW THE APP: start a dev server with **run_command** (long-running commands auto-move to the background after ~15s, or pass \`background:true\`), then drive the live preview with browser_navigate / browser_inspect / browser_interact using target:"preview" (open routes, click, fill forms). When the server prints a localhost URL the preview loads it automatically.
- Use web_search (one per topic per turn)
- Answer questions and use attachments (read_attachment, list_attachments)

You CANNOT (these mutate the source/repo — switch to Build/Debug for code changes):
- Write or edit files (edit_file) or create plans (the plan tool)
- Run MUTATING/DESTRUCTIVE commands: git add/commit/push/reset/checkout, rm/mv/cp/chmod, publish, deploy, etc. (these are blocked here — installs/builds/dev servers are fine)

Do not claim run_command is unavailable, and do not refuse to start a dev server, install deps, or preview the app — those are allowed here. For git history/status, call run_command instead of reading .git/objects.

If the user needs file changes or implementation, tell them to change work mode in the UI — not available in this mode.`,

    plan: `## Current mode: Plan

You are in Plan mode. Planning and architecture for this chat turn.

You CAN:
- Read and search the codebase; run_command for read-only git/shell
- Manage the session plan with the **plan** tool (operation: "write" to create/revise, "read", "set_status", "update_step", "append_step")
- edit_file (operation:"write") only for .atlarix/atlarix.md and .atlarix/memory.md
- glob / grep to navigate the codebase and the session plan tool

You CANNOT:
- Edit application source code or run build/install commands

If the user wants code implementation, tell them to change work mode in the UI.`,

    build: `## Current mode: Build

You are in Build mode. Full implementation for this chat turn.

You CAN:
- Read and write files (approval queue for mutating operations)
- run_command, all workspace tools via progressive reveal
- Verify with the project's own checks/tests (run_command) and write tests for new logic
- Spawn parallel read-only sub-agents with multiple task calls in one response for independent reconnaissance
- Delegate an isolated implementation to a WRITER sub-agent — task({write:true, ...}) or task({subagent_type:"implementer", ...}); it works in a throwaway git worktree (seeded from your current working tree) and returns a reviewable diff you apply with your own write tools. Built-in agents: explorer (read-only recon), architect (planning), implementer (writer)

Focus on correct, complete implementation. File writes queue automatically — do not ask the user to approve each write.

Plan lifecycle: when an active session plan appears in context (it includes its planId and status), call plan({operation:"set_status", planId, plan_status:"building"}) before implementing it and plan({operation:"set_status", planId, plan_status:"built"}) once the implementation satisfies the plan. Mark individual checklist steps with plan({operation:"update_step", planId, step_index, state}) as you start ("in_progress") and finish ("done") each one.`,

    debug: `## Current mode: Debug

You are in Debug mode. Hypothesis-first debugging for this chat turn.

You CAN:
- Investigate (read, glob, grep, run_command for repro/tests)
- State your hypothesis IN YOUR REPLY (root cause + evidence + files) before any write/edit/delete/rename
- Minimal file changes that test the stated hypothesis only
- Delegate a scoped fix to a WRITER sub-agent once your hypothesis is stated — task({write:true, ...}) or task({subagent_type:"implementer", ...}) works in an isolated worktree and returns a reviewable diff; review it before landing. Read-only helpers: explorer (recon), architect (planning)

You CANNOT:
- Change files before stating a hypothesis
- Refactor unrelated code or add features

Workflow: investigate → state hypothesis → minimal fix → run the project's own tests/checks (run_command) → revise hypothesis if needed.`,

    review: `## Current mode: Review

You are in Review mode. Read-only quality review for this chat turn.

You CAN:
- Read files, glob, grep, run_command for read-only git/tests/linter output
- Parallel task sub-agents for large diffs

You CANNOT:
- Write or edit source files, or run mutating commands. \`edit_file\` and mutating \`run_command\` are BLOCKED in this mode — do not attempt them (it only wastes the turn).

Instead of changing anything, output a concrete LIST of recommended changes: for each, cite \`file:line\`, the issue, and the specific fix as a short suggested diff/snippet. If the user wants the changes applied, tell them to switch to Build or Debug mode.`,
  };
  return blocks[mode] ?? blocks.ask;
}

/** Extra behavior without duplicating the header (no other mode names). */
function getActiveModeWorkExtras(mode: ModeRegistryKey): string {
  switch (mode) {
    case "ask":
      return `<work_mode>
Discovery: glob to find files by NAME (mtime-sorted); grep to search file CONTENTS (results are relevance-ranked, most relevant files first); then read_file for exact ranges.
At most 5 task calls per turn when batching independent scopes.
You may run non-mutating commands (reads, tests, builds, installs, dev servers — long-running ones auto-background after ~15s) and exercise the live preview (browser_* with target:"preview"). Do not use edit_file or run mutating/destructive commands (git add/commit/push/reset, rm/mv/chmod, publish, deploy) — switch to Build/Debug for those.
</work_mode>`;
    case "plan":
      return `<work_mode>
Session plans live in the plan tool (not on-disk roadmap files): plan({operation:"write", ...}) to create/revise, plan({operation:"read"}) before revising. After saving, include the returned marker comment in your reply so the UI shows a plan card. edit_file is for .atlarix docs only: atlarix.md (durable project instructions) and memory.md (project knowledge: stack, architecture, layout).
</work_mode>`;
    case "build":
      return `<work_mode>
Use native function tools for operations. Project files belong at workspace root, not under .atlarix/ unless asked.
One run_command for scaffolding when creating projects. For whole-file writes keep each edit_file (operation:"write") focused (≲800 lines) so large writes aren't truncated against the output-token budget; split bigger files across calls.
Verify your changes with the project's OWN tooling: after edits, discover and run the project's checks via run_command — prefer its package.json scripts (typecheck/lint/test/build), else the real tools directly (tsc --noEmit, eslint, ruff/mypy/pytest, cargo check, go build) — and fix from the output. Read package.json / Makefile / pyproject.toml to find the actual commands; do not invent script names. Use \`node --check\` / \`python3 -m py_compile\` as a syntax floor when no linter exists. Never claim a change is clean while a check still reports errors.
When the task involves non-trivial logic, write or extend test files that genuinely exercise it and run them before completing (skip the ceremony for trivial edits like renames or copy tweaks).
If implementing an active session plan (see its planId in context), call plan({operation: "set_status", planId, plan_status: "building"}) first and plan({operation: "set_status", planId, plan_status: "built"}) when the plan is fully implemented.
Live step progress: as you START each plan checklist step call plan({operation: "update_step", planId, step_index, state: "in_progress"}), and "done" when that step is finished — the plan card updates live for the user.
The user can add items to the plan while you build. Before moving to the next step, call plan({operation: "read", planId}) to pick up any additions, and honor them. To add a step yourself, use plan({operation: "append_step", planId, step_text}) rather than rewriting the whole plan.
Work the task toward completion in this turn: when you say you will do something next, do it now — don't stop after only planning, describing what remains, or reporting status. Build on tool results you already have — don't re-read a file or re-run the same command just to view its output differently; run it once asking for enough output, then reason from that. BUT self-regulate, like a careful engineer: if a check/test keeps failing after ~3 focused fix attempts, STOP and report what you changed, the exact remaining failure, and your best next hypothesis — do NOT keep re-running the same check or grinding. Yield when the task is done and its checks pass, OR when you are genuinely stuck after real attempts — then give a brief summary and ask ONE concrete question.
When fully done and the project's checks/tests pass, simply stop — your turn ends automatically when you make no more tool calls.
</work_mode>`;
    case "debug":
      return `<work_mode>
Hypothesis-first: state your hypothesis (root cause + evidence) in your reply, then make minimal edits aligned to that hypothesis only.
Verify the fix by running the project's OWN failing tests / typecheck / linter via run_command (discover them from package.json scripts, Makefile, or pyproject.toml). When feasible, add a focused regression test that reproduces the bug and passes after the fix.
When the fix is verified and the failing checks pass, simply stop — your turn ends automatically when you make no more tool calls.
</work_mode>`;
    case "review":
      return `<work_mode>
Read-only review: cite files and concrete issues; never mutate. Do NOT call edit_file or mutating commands (they are rejected here and waste the turn) — instead present a numbered LIST of recommended changes (file:line → issue → suggested fix/diff). End by noting the user can switch to Build or Debug mode to apply them.
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
    // browser_* tools are dropped from the headless toolset — don't advertise them.
    process.env.ATLARIX_HEADLESS === "1" ? "" : BROWSER_NOTE,
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
