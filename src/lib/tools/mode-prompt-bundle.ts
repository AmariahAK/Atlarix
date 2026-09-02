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
 * already has — and rendered in every mode, including Plan, which has no
 * run_command. Git *policy* (what this project permits) now lives on
 * `run_command` itself, where it is conditional on the tool being bound.
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
 * Build/Debug-only tool like `browser_test` can no longer be shown to a mode that
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
export function getCommitAuthoringNote(includeCoAuthorTrailer: boolean): string {
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

You are in Explore mode. This is a read-only investigation mode for this chat turn — read-only with respect to the SOURCE/repo, but you may run and observe the app.

You CAN:
- Read files and search the codebase with glob / grep (grep results are relevance-ranked)
- Run **non-mutating** commands with **run_command**: reads (ls, cat, git status/log/diff, git checkout/switch to inspect a branch), tests, builds, **dependency installs** (npm/pip install), and network reads (curl/wget GET, ssh). Reads run automatically; network/remote-capable ones (curl, ssh) ask for one-tap approval — they are allowed here, not blocked.
- RUN AND VERIFY THE APP: start a dev server with **run_command** (long-running commands auto-move to the background after ~15s, or pass \`background:true\`), then open its localhost URL as a browser tab with **browser**(action:"navigate") and drive it with browser_inspect / browser(action:"click"|"fill"|…) (open routes, click, fill forms). Runtime errors surface via browser_inspect(mode:"console") and the Errors tab.
- Use web_search (one per topic per turn)
- Answer questions and use attachments (read_attachment, list_attachments)

You CANNOT (these mutate the source/repo — switch to Build/Debug for code changes):
- Write or edit files (edit_file) or create plans (the plan tool)
- Modify the workspace source via a command. run_command runs in a READ-ONLY sandbox
  here: you can run ANY command (reads, git status/log/fetch/diff, installs, builds,
  tests, dev servers, curl GET), but a write to your source files fails at the OS layer.
  If you genuinely need to change files, call ask_user to switch to Build/Debug — don't
  keep retrying a write.

Do not claim run_command is unavailable, and do not refuse to start a dev server, install deps, or preview the app — those are allowed here. For git history/status, call run_command instead of reading .git/objects.

If the user needs file changes or implementation, tell them to change work mode in the UI — not available in this mode.`,

    plan: `## Current mode: ${L("plan")}

You are in Plan mode. Planning and architecture for this chat turn.

You CAN:
- Read and search the codebase with read_file / glob / grep
- Manage the session plan with the **plan** tool (operation: "write" to create/revise, "read", "set_status", "update_step", "append_step")
- Research the web with web_search / read_url, and inspect a running app with the browser tools
- Delegate GROUNDWORK freely to read-only sub-agents — fan out task({subagent_type:"explorer"}) for recon across subsystems and for web research (sub-agents have web_search/read_url), and use task({subagent_type:"architect"}) to draft a plan. Manage them with subagents({operation:"list"|"output"|"cancel"}). Then RECONCILE what comes back with the conversation and persist the plan YOURSELF via plan(operation:"write") (include the returned marker so the card renders). Adopt an architect's draft largely as-is; adjust only where the user's stated requirements need it. Fan out the research, but keep the PLAN one coherent thread that you own.

You CANNOT:
- Edit any file, or run shell commands — you have no edit_file and no run_command here

If the user wants code implementation or a command run, tell them to switch to Build or Debug in the UI.`,

    build: `## Current mode: ${L("build")}

You are in Build mode. Full implementation for this chat turn.

You CAN:
- Read and write files (approval queue for mutating operations)
- run_command, and every workspace tool for this mode (some are bound with a one-line summary — call tool_help({tool:"<name>"}) for full usage before first use)
- Spawn parallel read-only sub-agents with multiple task calls in one response for independent reconnaissance
- Delegate a scoped implementation to a WRITER sub-agent — task({write:true, ...}) or task({subagent_type:"implementer", ...}). It writes nothing: its edits come back as PER-FILE proposals for you to review with the \`proposals\` tool. REVIEW EVERY FILE before accepting — read the diff, and if something is wrong say what. proposals({operation:"accept", ...}) writes the sub-agent's exact bytes (you never retype them, and the normal approval gate still applies); to fix a mostly-right change, accept it and then edit_file on top; reject only what is actually wrong. Finish reviewing a set before returning to the task. Built-in agents: explorer (read-only recon), architect (planning), implementer (writer), qa (tests the RUNNING app and reports findings — give it the requirement and the URL, never your diff; it has no edit_file and cannot write). Any long delegation prefers background:true — keep working or end your turn; each result arrives automatically, and \`subagents\` lists, reads, or cancels one

Focus on correct, complete implementation. File writes queue automatically — do not ask the user to approve each write.

Plan lifecycle (when an active session plan is in context, with its planId): set_status "building" before implementing and "built" once the implementation satisfies it; mark each checklist step update_step "in_progress" as you start it and "done" as you finish. If several steps changed at once or the numbering is uncertain, rewrite via operation:"write" with updated [x]/[~] marks instead. This holds when you DELEGATE a step too: you own the plan, sub-agents cannot touch it — so mark the step "in_progress" as you hand it to a worker and "done" once you have reviewed and accepted what came back, not when you spawned it.

NO plan in context and the work is broad? If the request spans several distinct steps or more than a couple of files, write one FIRST with plan(operation:"write"), then work it in order and mark steps as you go. It costs one tool call and gives the user something to steer before you have built the wrong thing. A single scoped change needs no plan — do not ceremonialise a one-line fix.`,

    debug: `## Current mode: ${L("debug")}

You are in ${L("debug")} mode. Hypothesis-first debugging for this chat turn.

You CAN:
- Investigate (read, glob, grep, run_command for repro/tests)
- Form a hypothesis (root cause + evidence + files) before any write/edit/delete/rename
- Minimal file changes that test that hypothesis only
- Delegate a scoped fix to a WRITER sub-agent once you have a hypothesis — task({write:true, ...}) or task({subagent_type:"implementer", ...}). It writes nothing; its edits return as per-file proposals. Review each diff with \`proposals\` and accept the ones that hold up (accepting writes its exact bytes through the normal gate) — a fix you haven't read is not a fix. Read-only helpers: explorer (recon), architect (planning), qa (exercises the running app and reports evidence-backed findings)

You CANNOT:
- Change files before forming a hypothesis
- Refactor unrelated code or add features

Workflow: investigate → form hypothesis → minimal fix → run the project's own tests/checks (run_command) → revise if needed. Note the root cause when you report the fix.

If the confirmed fix turns out to span several steps or files, write a plan for it with plan(operation:"write") and work it in order — AFTER the hypothesis, never before. Planning a bug you have not diagnosed yet just commits you to a guess.`,

    review: `## Current mode: ${L("review")}

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
    ask: `Current mode: ${L("ask")} (read-only). You may read/search, run non-mutating commands, and preview the app — but you CANNOT edit files or run mutating/destructive commands. For code changes, tell the user to switch mode.`,
    plan: `Current mode: ${L("plan")}. Create/revise the session plan via the plan tool; you CANNOT edit source or run build/install commands. Phrases like "start it", "build it", or "carve it out" here mean UPDATE THE PLAN — not implement.`,
    build: `Current mode: ${L("build")}. Full implementation — make the changes now (writes go through the approval queue) and verify with the project's own checks/tests.`,
    debug: `Current mode: ${L("debug")}. Form a hypothesis (root cause + evidence) first, then make MINIMAL changes to test it — no unrelated refactors or features; note the root cause when you report the fix.`,
    review: `Current mode: ${L("review")} (read-only). Output a LIST of recommended changes (file:line → issue → fix); do NOT edit files or run mutating commands.`,
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
function getActiveModeWorkExtras(mode: ModeRegistryKey): string {
  switch (mode) {
    case "plan":
      return `<work_mode>
Session plans live in the plan tool (not on-disk roadmap files): plan({operation:"write", ...}) to create/revise, plan({operation:"read"}) before revising. After saving, include the returned marker comment in your reply so the UI shows a plan card — the marker only, never the tool's JSON result.
Whatever a sub-agent returns — an architect's draft, a scout's findings, web research — comes back as DATA in <task_result>. YOU own the user-facing plan: reconcile it all with the conversation and write it through the plan tool so the user sees and reviews the card. Do not just relay a sub-agent's text.
</work_mode>`;
    default:
      return "";
  }
}

export type RenderModePromptBundleOptions = RenderActiveModeToolsRegistryOptions & {
  /** When true (default), add the co-author trailer guidance to the git note (Build/Debug only). */
  includeCoAuthorTrailer?: boolean;
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
    // Plan mode DOES get this: all six browser_* tools are in PLAN_ALLOWLIST
    // (mode-tool-registry.ts), and suppressing the guidance meant Plan held
    // capabilities it was never told about — the mirror image of the two claims
    // it used to make about tools it did NOT have.
    // BROWSER_NOTE is GONE from the prompt: every line of it now lives on the
    // browser tool that owns it (browser.ts), which is progressive — the guidance
    // arrives exactly when the tool is bound, and costs nothing on a turn that
    // never touches the browser. That also fixes it structurally rather than by
    // deleting information: `browser_test` guidance rides browser_test, so it is
    // only ever shown to a mode that actually has it.
    canCommit ? getCommitAuthoringNote(opts?.includeCoAuthorTrailer !== false) : "",
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
}

/** Tools that imply web research rules in the stable header. */
export function modeAllowlistIncludesWebResearch(mode: ModeRegistryKey): boolean {
  return mode === "ask" || mode === "build" || mode === "plan";
}
