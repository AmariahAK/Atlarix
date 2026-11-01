/**
 * Active-mode prompt bundle — current mode header, behavior, tools_registry.
 * No other work modes named in prose (per-turn scope only).
 */

import type { ModeRegistryKey } from "./mode-tool-registry";
import {
  getModeRegistryDisplayLabel,
  renderActiveModeToolsRegistry,
  type RenderActiveModeToolsRegistryOptions,
} from "./mode-tool-registry";
import { ATLARIX_CO_AUTHOR_TRAILER } from "@/ipc/utils/git_author";

/**
 * DELETED: `GIT_VIA_TERMINAL_NOTE`.
 *
 * It taught the model `git status` / `git log` / `git diff` — capability it
 * already has — and rendered in every mode, including modes with no
 * run_command bound at the time. Git *policy* (what this project permits) now
 * lives on `run_command` itself, conditional on the tool being bound.
 *
 * Only the co-author trailer stays in the prompt, below: it depends on a user
 * SETTING, so it cannot be baked into a static tool description.
 */

/**
 * DELETED: `BROWSER_NOTE` (1,872 chars, rendered in four of five modes).
 *
 * Every line of it moved onto the browser tool that owns it (browser.ts). Tool
 * descriptions are progressive — they enter context only when the tool is bound —
 * so a turn that never touches a browser now pays nothing, and guidance for a
 * mode-restricted tool can no longer be shown to a mode that
 * cannot call it. Asserted by mode-reanchor.test.ts against the descriptions.
 */

/**
 * Commit-authoring policy for commit-capable modes. Commits are authored by the
 * user's own git config — never `--author`. When the co-author setting is on, the
 * agent is credited via a trailer line only.
 *
 * Stays in the prompt (rather than moving to `run_command` with the rest of the
 * git policy) because it is driven by the `includeAtlarixCoAuthor` setting, and
 * tool descriptions are fixed at registration.
 */
export function getCommitAuthoringNote(
  includeCoAuthorTrailer: boolean,
): string {
  const base =
    "When you create git commits, let the user's own git config author them — do not pass `--author` or set `user.name`/`user.email`. Never change the user's git config.";
  if (!includeCoAuthorTrailer) return base;
  return `${base}
End every commit message with the trailer line \`${ATLARIX_CO_AUTHOR_TRAILER}\` (blank line before it) so Atlarix is credited as co-author.`;
}

/**
 * ## Current mode: {label} + CAN/CANNOT (active mode only).
 *
 * The label comes from `getModeRegistryDisplayLabel`, never a literal — which in
 * turn now comes from `labelForWorkMode`, the function the mode picker itself
 * renders. That second hop is the actual fix: consolidating the PROMPT's copies
 * onto `MODE_LABELS` left `MODE_LABELS` itself as a rival to the UI's map, and
 * they had drifted — it said "Fix" for debug while the picker said "Debug". So
 * every prompt surface agreed with every other prompt surface and all of them
 * disagreed with the screen. A user asking to "switch to Debug mode" was naming
 * something the prompt called Fix. Pinned by mode-label-parity.test.ts.
 */
export function getActiveModeHeaderBlock(mode: ModeRegistryKey): string {
  const L = (m: ModeRegistryKey) => getModeRegistryDisplayLabel(m);
  const blocks: Record<ModeRegistryKey, string> = {
    ask: `## Current mode: ${L("ask")}

You are in Explore mode. Investigation for this chat turn: you can run the project, but you cannot change it.

You CAN:
- Read files and search the codebase with glob / grep (grep results are relevance-ranked)
- Run commands with **run_command** — the workspace is writable, so installs, builds, tests and dev servers all work normally
- RUN AND VERIFY THE APP: start a dev server, then open its localhost URL with **browser**(action:"navigate") and drive it with browser_inspect / browser(action:"click"|"fill"|…)
- Use web_search (one per topic per turn)
- Answer questions and use attachments (read_attachment, list_attachments)

You CANNOT:
- Write or edit files (no edit_file here) or create plans (the plan tool)
- Change the source with a command without asking. Editing a file in place, redirecting
  into one, or rewriting git state goes to the user for approval first — that is a PAUSE,
  not a failure, so do not retry it or reach for a different command that does the same
  thing. If the work needs file changes, call ask_user to switch to Build/Debug.

If the user needs implementation, tell them to change work mode in the UI.`,

    plan: `## Current mode: ${L("plan")}

You are in Plan mode. Planning and architecture for this chat turn.

You CAN:
- Read and search the codebase with read_file / glob / grep
- **CHECK BEFORE YOU COMMIT TO A PLAN** — run_command works here: git history, the project's own
  typecheck or tests. A plan built on a guess you could have verified in one command is this
  mode's failure
- Manage the session plan with the **plan** tool (operation: "write" to create/revise, "read", "set_status", "update_step", "append_step")
- Research the web with web_search / read_url. To look at the RUNNING app, write it as a step: that is Explore's job, not this mode's
- Delegate GROUNDWORK freely to read-only sub-agents — fan out task({subagent_type:"explore"}) for code recon and web research; manage them with subagents({operation:"list"|"output"|"cancel"}). Then RECONCILE what comes back and persist the plan YOURSELF via plan(operation:"write") (include the returned marker so the card renders). Fan out the research; keep the PLAN one coherent thread that you own.

You CANNOT:
- Edit any file — there is no edit_file here
- Change the source with a command without asking — an in-place edit, a redirect into a file or
  a git write goes to the user for approval. Investigate freely; implement nothing.

If the user wants the plan carried out, tell them to switch to Build or Debug in the UI.`,

    build: `## Current mode: ${L("build")}

You are in Build mode: full implementation. File writes go through the approval queue on their own; don't ask the user to approve each one.

- Every workspace tool for this mode is yours (some are bound with a one-line summary: call tool_help({tool:"<name>"}) before first use).
- Fan out independent recon to parallel read-only \`task\` sub-agents. A WRITER sub-agent (task with write:true, or subagent_type:"build") returns per-file proposals: read each diff before you accept it with \`proposals\` (accepting writes its exact bytes; fix a mostly-right one with an edit on top). Prefer background:true for long delegations; results arrive by themselves.
- To prove a test can fail, break a temporary copy (os temp dir), never the user's files.
- Plans: for work spanning several steps or files, write a plan first (\`plan\`), a one-line fix needs none. With a plan active, keep one step in_progress, mark each done once verified (including steps you delegated, after you accept the result), and keep going until none is yours; mark a step external when only the user can do it.`,

    debug: `## Current mode: ${L("debug")}

You are in ${L("debug")} mode. Hypothesis-first debugging for this chat turn.

You CAN:
- Investigate (read, glob, grep, run_command for repro/tests)
- Form a hypothesis (root cause + evidence + files) before any change
- Minimal file changes that test that hypothesis only
- Delegate a scoped fix to a writer sub-agent once you have a hypothesis (task with write:true), reading each proposed diff before you accept it — a fix you haven't read is not a fix. Read-only helper: the explore sub-agent

You CANNOT:
- Refactor unrelated code or add features

Workflow: investigate → form hypothesis → minimal fix → run the project's own tests/checks (run_command) → revise if needed. Note the root cause when you report the fix.

If the confirmed fix turns out to span several steps or files, write a plan for it with plan(operation:"write") and work it in order — AFTER the hypothesis, never before. Planning a bug you have not diagnosed yet just commits you to a guess.`,

    review: `## Current mode: ${L("review")}

You are in Review mode. Read-only review of the part the user names and everything connected to it — callers, data, other repos, shared state.

You CAN:
- Read files, glob, grep, and run_command for evidence — git history, the project's own typecheck, linter and test suite all run normally here
- Parallel task sub-agents for large diffs

You CANNOT:
- Write or edit source files — there is no \`edit_file\` here
- Change the source with a command without asking. A mutating command goes to the user for
  approval first, so do not reach for one as a way to apply a finding.

Instead of changing anything, output a concrete LIST of recommended changes: for each, cite \`file:line\`, the issue, and the specific fix as a short suggested diff/snippet. If the user wants the changes applied, tell them to switch to Build or Debug mode.`,
  };
  return blocks[mode] ?? blocks.ask;
}

/**
 * Compact one-line active-mode re-anchor, injected as an ephemeral note right
 * AFTER the latest user turn so it is the LAST thing the model reads. The full
 * mode block lives in the (cached) system prefix; weaker models over-weight
 * recency and drift toward the previous mode's behavior after a switch — this
 * pins the current mode's CAN/CANNOT essence at the point of action.
 */
export function getActiveModeReanchor(mode: ModeRegistryKey): string {
  const L = (m: ModeRegistryKey) => getModeRegistryDisplayLabel(m);
  const lines: Record<ModeRegistryKey, string> = {
    ask: `Current mode: ${L("ask")}. Read, search, and RUN the project — builds, tests and dev servers work. You have no edit_file, and a command that changes the source asks the user first. For code changes, tell the user to switch mode.`,
    plan: `Current mode: ${L("plan")}. Create/revise the session plan via the plan tool. You CAN run commands to check your assumptions before writing them down; you have no edit_file, and a command that changes the source asks the user first. Phrases like "start it", "build it", or "carve it out" here mean UPDATE THE PLAN — not implement.`,
    build: `Current mode: ${L("build")}. Full implementation — make the changes now (writes go through the approval queue) and verify with the project's own checks/tests.`,
    debug: `Current mode: ${L("debug")}. Form a hypothesis (root cause + evidence) first, then make MINIMAL changes to test it — no unrelated refactors or features; note the root cause when you report the fix.`,
    review: `Current mode: ${L("review")}. Review the part the user named and what connects to it (callers, data, other repos, shared state); answer with the path to each point, then a LIST of recommended changes (file:line → issue → fix). Run the project's own checks for evidence; you have no edit_file, and a command that changes the source asks the user first.`,
  };
  return lines[mode] ?? lines.ask;
}

/**
 * Mode WORKFLOW — Plan only.
 *
 * This layer used to render for all five modes and was the third statement of the
 * same rules: the header said them, `<work_mode>` said them again, and the reanchor
 * said them a third time. It is deleted for Explore/Build/Fix/Review, whose CAN /
 * CANNOT is enforced by the toolset and the sandbox and stated once in the header.
 *
 * Plan keeps it because Plan is the one mode that is a WORKFLOW rather than a
 * permission set — there is no sandbox that makes you reconcile a sub-agent's draft
 * into a plan the user can review. Everything genuinely non-obvious from the other
 * four moved to where it belongs: the ≲800-line write cap onto `edit_file`, the
 * verification and red-test discipline into `skills/modes/build-mode.md`, the
 * 5-task batching cap into `skills/modes/ask-mode.md`, and the discovery order into
 * glob/grep's own descriptions.
 */
function getActiveModeWorkExtras(mode: ModeRegistryKey, inlinePlans = false): string {
  switch (mode) {
    case "plan":
      return `<work_mode>
Session plans live in the plan tool (not on-disk roadmap files): plan({operation:"write", ...}) to create/revise, plan({operation:"read"}) before revising. After saving, include the returned marker comment in your reply so the UI shows a plan card — the marker only, never the tool's JSON result.
Whatever a sub-agent returns — a scout's findings, web research — comes back as DATA in <task_result>. YOU own the user-facing plan: reconcile it all with the conversation and write it through the plan tool so the user sees and reviews the card. Do not just relay a sub-agent's text.${
        inlinePlans
          ? "\nA plan written as numbered steps in your reply is saved as the session's plan too, with Build it, so never say no plan was saved."
          : ""
      }
</work_mode>`;
    default:
      return "";
  }
}

export type RenderModePromptBundleOptions =
  RenderActiveModeToolsRegistryOptions & {
    /** When true (default), add the co-author trailer guidance to the git note (Build/Debug only). */
    includeCoAuthorTrailer?: boolean;
    /**
     * The surface saves a Plan-mode reply that IS a plan as the session's plan
     * (the CLI and the editor: src/cli/agent/inline-plan.ts). Plan mode is told
     * so; the desktop app does not do this, so its prompt says nothing.
     */
    inlinePlans?: boolean;
  };

/** Single active-mode block: header + work_mode + tools_registry + git note. */
export function renderModePromptBundle(
  mode: ModeRegistryKey,
  opts?: RenderModePromptBundleOptions,
): string {
  const canCommit = mode === "build" || mode === "debug";
  return [
    getActiveModeHeaderBlock(mode),
    getActiveModeWorkExtras(mode, opts?.inlinePlans === true),
    renderActiveModeToolsRegistry(mode, opts),
    // browser_* tools are dropped from the headless toolset — don't advertise them.
    // Plan mode DOES get this: all six browser_* tools are in PLAN_ALLOWLIST
    // (mode-tool-registry.ts), and suppressing the guidance meant Plan held
    // capabilities it was never told about — the mirror image of the two claims
    // it used to make about tools it did NOT have.
    // BROWSER_NOTE is GONE from the prompt: every line of it now lives on the
    // browser tool that owns it (browser.ts), which is progressive — the guidance
    // arrives exactly when the tool is bound, and costs nothing on a turn that
    // never touches the browser. That also fixes it structurally rather than by
    // deleting information: each tool's guidance rides that tool, so it is only
    // ever shown to a mode that actually has it.
    canCommit
      ? getCommitAuthoringNote(opts?.includeCoAuthorTrailer !== false)
      : "",
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
}

/** Tools that imply web research rules in the stable header. */
export function modeAllowlistIncludesWebResearch(
  mode: ModeRegistryKey,
): boolean {
  return mode === "ask" || mode === "build" || mode === "plan";
}
