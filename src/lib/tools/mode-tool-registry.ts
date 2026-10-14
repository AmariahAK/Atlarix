/**
 * Per-mode tool allowlists — single source of truth for prompts, native ToolSet
 * filtering, and execute-time gates.
 *
 * THE TOOL-RESOLUTION PIPELINE (v12 3.10 — one documented order, four stages):
 *   1. registry metadata   — ToolRegistry (registry.ts): per-tool flags
 *      (isReadOnly / allowInAskMode / requiresWorkspace / isCore / cost)
 *   2. mode allowlist      — THIS FILE: includeToolForSession / allow-sets
 *   3. description tiering — tool-reveal.ts (v14.34): per-MODE progressive
 *      reveal. Every allowlisted tool's name + schema still bind; a peripheral
 *      tool's DESCRIPTION is trimmed to one line plus a `tool_help` pointer.
 *      (The v13-era `ToolSessionLoader`, which withheld whole tools until first
 *      call, is gone — it could not survive prompt caching, since the tool
 *      definitions live inside the first cache breakpoint.)
 *   4. capability trim     — model-capability-profile.ts (v12 2.1): per-model
 *      schema simplification for clearly-weak models. LAST stage; the
 *      offered set is what survives all four.
 * Execute-time gating re-checks stage 2 (and the permission layer) — a tool
 * that is not offered can still be DENIED if a model hallucinates a call.
 *
 * v12 S19 (3.10 CLOSED): the pipeline is ASSEMBLED in exactly one place —
 * `resolveToolsetForSession` (resolve-toolset.ts). Both stream branches call
 * it; the exact offered surface per mode is pinned by the toolset-golden eval.
 */

import type { WorkMode } from "@/lib/schemas";
import { labelForWorkMode } from "@/lib/work-mode";
import {
  isWorkspaceIntegrationTool,
  WORKSPACE_INTEGRATION_TOOL_NAMES,
} from "./ToolManifest";

export type ModeRegistryKey = WorkMode;

/** Documented in registry text when mode is build (the whole context surface). */
export const BUILD_ALLOWLIST_MARKER = "*" as const;

/**
 * Tools available in EVERY work mode — must stay in sync with the
 * `<tool_contract>` block in system_prompt.ts. Unioned into each mode's
 * allowlist so the prompt-rendered registry and the execute-time gate agree.
 */
export const EVERY_MODE_TOOLS = [
  "ask_user",
  "compress_context",
  "list_attachments",
  "read_attachment",
  "read_url",
  "web_search",
  // R1: opt-in self-wake — available in every mode (build/debug get it via "*").
  "schedule_wakeup",
  // v14.21: managing sub-agents belongs wherever delegating them does — which
  // is every mode. Plan delegates read-only recon and web research, so it must
  // be able to list, read and cancel what it delegated.
  "subagents",
  // v14.34: the fetch half of per-mode progressive tool reveal. Must be in
  // EVERY mode — a peripheral tool's bound description points at it, so a mode
  // that offered the pointer without the tool would be a dead end.
  "tool_help",
  // v14.39: the other half of compaction. EVERY mode compacts, so every mode can
  // lose a detail to a summary and must be able to read back behind the boundary.
  // Read-only, so it is safe on the Ask/Plan/Review surfaces.
  "session_search",
  // v14.41: the mobile pair, EVERY mode — for the same reason `browser` is every
  // mode. Neither touches the workspace: driving an emulator changes the state of
  // a device, not the project, so Plan's filesystem-read-only rule is untouched.
  // And the read half is the point in Explore: "what does the app look like on a
  // phone" is a question, not a build step.
  //
  // The tokens are affordable because both are PERIPHERAL under tool-reveal, so
  // every mode binds one sentence plus a `tool_help` pointer rather than the full
  // description — which is why their first sentences carry the cheap default.
  "mobile_inspect",
  "mobile",
  // Looking at an image file is a read: every mode, Plan and Explore included
  // ("what does this screenshot show" is a question, not a build step).
  "view_image",
  "transcribe_audio",
  // Talking to the user's other sessions changes nothing here; every mode.
  "list_sessions",
  "send_message",
] as const;

/**
 * Tools an otherwise-every-mode entry does NOT reach in a given mode.
 *
 * This exists for exactly one case and should stay that small. `mobile_inspect`
 * and `mobile` were made every-mode on the argument, recorded in
 * EVERY_MODE_TOOLS above, that "what does the app look like on a phone" is a
 * QUESTION rather than a build step. That argument is about Explore. Plan does
 * not answer questions about a running device; it writes down what should be
 * done, and it is the one mode with no budget headroom to spare — the pair is a
 * measured 471 tokens per mode (`prompt-budget.eval.test.ts`), and Plan is where
 * `run_command` now has to fit.
 *
 * Anything excluded here is genuinely unreachable in that mode, including at the
 * execute-time gate, so add to it only when the mode truly has no use for the
 * tool — never merely to save tokens somewhere with room.
 */
export const MODE_EXCLUDED_TOOLS: Partial<
  Record<ModeRegistryKey, readonly string[]>
> = {
  plan: ["mobile", "mobile_inspect"],
  // Review reads and verifies code; transcribing audio is not part of that, and
  // its schema pushed Review over its prompt-budget ceiling (2026-10-07). It
  // stays in every other mode. `view_image` and the session pair stay here: a
  // review can look at a screenshot and hand its findings to a Build session.
  review: ["transcribe_audio"],
};

function withEveryModeTools(
  list: readonly string[],
  excluded: readonly string[] = [],
): readonly string[] {
  const drop = new Set(excluded);
  return Object.freeze(
    [...new Set([...list, ...EVERY_MODE_TOOLS])]
      .filter((t) => !drop.has(t))
      .sort((a, b) => a.localeCompare(b)),
  );
}

const ASK_TOOLS = [
  "automations",
  "background_jobs",
  "browser",
  "browser_inspect",
  "glob",
  "grep",
  "list_available_mcps",
  "manage_mcp_server",
  "mcp_call",
  // Find a server the question needs and offer the user a card to connect it.
  "mcp_servers",
  "read_file",
  "run_command",
  "task",
] as const;

/**
 * Plan authors a PLAN and must not edit the source — so it has no `edit_file`,
 * and a write-shaped command asks the user first (`mutating-commands.ts`).
 *
 * IT DOES HAVE `run_command` NOW, and that is the point of the mode. Plan was
 * expected to produce an informed plan while being unable to check anything: no
 * `git log`, no `ls`, no typecheck, no test names. It inferred where it should
 * have looked. (It was also the worst of both — `run_command` carries
 * `allowInAskMode`, so a hallucinated call EXECUTED even though the tool was
 * never offered. Binding it reduces surprise rather than expanding surface.)
 *
 * `background_jobs` comes with it and is not optional: a foreground command
 * auto-promotes to the background after ~15s, so a Plan turn that runs the test
 * suite would otherwise lose its output permanently.
 *
 * WHAT CAME OUT TO PAY FOR THEM.
 *
 * `automations` and `manage_mcp_server` are both ACTS, and Plan's job is to write
 * down that an act should happen. Creating a scheduled automation is the thing a
 * plan step describes; installing an MCP server is, by `mcp.ts`'s own
 * description, "approving arbitrary process execution at the user's privilege".
 * `list_available_mcps` stays, so Plan can still see what exists and plan around
 * it.
 *
 * `browser` and `browser_inspect` came out too, and that one was a REVERSAL —
 * the plan for this change said to keep them, on the strength of the note in
 * mode-prompt-bundle.ts about a previous removal of Plan's browser GUIDANCE. But
 * that note is about suppressing guidance for tools Plan HAD, which is the
 * opposite mismatch; removing the tools removes their guidance with them.
 *
 * What actually decided it: `browser_inspect` cannot navigate — navigation lives
 * on `browser`. So keeping only the cheap one would have left Plan able to
 * inspect whatever page happened to be open and unable to open one, which is a
 * worse trap than having neither. And the pair is expensive: 1,324 tokens of
 * Plan's prefix, measured, because `browser_inspect` is in NEVER_TRIM and
 * `browser` carries a large action enum. Driving and reading a running app is
 * verification, which is what Explore is for — Plan can write "verify X in
 * Explore" as a step. With them gone Plan is SMALLER than before it gained
 * run_command (9,879 against a 10,962 baseline), which is the right shape for a
 * mode whose job is to decide rather than to do.
 */
const PLAN_TOOLS = [
  "background_jobs",
  "glob",
  "grep",
  "list_available_mcps",
  "mcp_call",
  "plan",
  "read_file",
  "run_command",
  "task",
] as const;

const REVIEW_TOOLS = [
  "automations",
  "background_jobs",
  "browser",
  "browser_inspect",
  "glob",
  "grep",
  "list_available_mcps",
  "manage_mcp_server",
  "mcp_call",
  "read_file",
  "run_command",
  "task",
] as const;

/** Full per-mode allowlists (mode-specific tools ∪ every-mode tools). */
const ASK_ALLOWLIST = withEveryModeTools(ASK_TOOLS);
const PLAN_ALLOWLIST = withEveryModeTools(PLAN_TOOLS, MODE_EXCLUDED_TOOLS.plan);
const REVIEW_ALLOWLIST = withEveryModeTools(
  REVIEW_TOOLS,
  MODE_EXCLUDED_TOOLS.review,
);

/** Backward-compatible export for system_prompt and tests. */
export const MODE_SYSTEM_TOOL_LISTS = {
  ask: ASK_ALLOWLIST,
  plan: PLAN_ALLOWLIST,
  build: [BUILD_ALLOWLIST_MARKER] as const,
  // v13: debug = full surface (differs from build by prompt discipline only).
  debug: [BUILD_ALLOWLIST_MARKER] as const,
  review: REVIEW_ALLOWLIST,
} as const;

/**
 * Display labels come from `labelForWorkMode` — the SAME function the mode
 * picker renders — so the prompt can never name a mode something the user
 * cannot find in the UI.
 *
 * This map used to be a second copy, and it had drifted: it said "Fix" for
 * `debug` while the picker said "Debug". Since the mode header interpolates it
 * ("You are in Fix mode (the UI labels it Fix…)"), the prompt was actively
 * telling the model the wrong name for a mode the user selects by name. That is
 * the exact failure the header's own comment claims to have solved by unifying
 * on one source — it unified on the wrong one, because a second source still
 * existed here.
 */
const MODE_LABELS: Record<ModeRegistryKey, string> = {
  ask: labelForWorkMode("ask"),
  plan: labelForWorkMode("plan"),
  build: labelForWorkMode("build"),
  debug: labelForWorkMode("debug"),
  review: labelForWorkMode("review"),
};

const ALLOWLIST_BY_MODE: Record<
  ModeRegistryKey,
  readonly string[] | typeof BUILD_ALLOWLIST_MARKER
> = {
  ask: ASK_ALLOWLIST,
  plan: PLAN_ALLOWLIST,
  build: BUILD_ALLOWLIST_MARKER,
  debug: BUILD_ALLOWLIST_MARKER,
  review: REVIEW_ALLOWLIST,
};

let allowSetsCache: Record<ModeRegistryKey, Set<string>> | null = null;

function getAllowSets(): Record<ModeRegistryKey, Set<string>> {
  if (!allowSetsCache) {
    allowSetsCache = {
      ask: new Set(ASK_ALLOWLIST),
      plan: new Set(PLAN_ALLOWLIST),
      build: new Set(),
      debug: new Set(),
      review: new Set(REVIEW_ALLOWLIST),
    };
  }
  return allowSetsCache;
}

/** Sets used for execute-time gating (build = empty set → allow all at gate). */
export function getModeToolAllowSets(): Record<ModeRegistryKey, Set<string>> {
  return getAllowSets();
}

export function getModeToolAllowlist(mode: ModeRegistryKey): readonly string[] {
  const entry = ALLOWLIST_BY_MODE[mode];
  if (entry === BUILD_ALLOWLIST_MARKER) {
    return [BUILD_ALLOWLIST_MARKER];
  }
  return entry;
}

export function isToolAllowedInMode(
  toolName: string,
  mode: ModeRegistryKey,
): boolean {
  if (mode === "build" || mode === "debug") return true;
  return getAllowSets()[mode].has(toolName);
}

export type IncludeToolForSessionOptions<
  T extends { name: string } = { name: string },
> = {
  loaded: Set<string>;
  hasWorkspace: boolean;
  mode: ModeRegistryKey;
  isCore?: (tool: T) => boolean;
};

export function includeToolForSession<T extends { name: string }>(
  tool: T,
  opts: IncludeToolForSessionOptions<T>,
): boolean {
  const inSession =
    opts.loaded.has(tool.name) ||
    (opts.isCore?.(tool) ?? false) ||
    (opts.hasWorkspace && isWorkspaceIntegrationTool(tool.name));
  if (!inSession) return false;
  return isToolAllowedInMode(tool.name, opts.mode);
}

/** Filter native ToolSet candidates to the active mode allowlist + session rules. */
export function filterToolsForActiveMode<T extends { name: string }>(
  tools: T[],
  opts: IncludeToolForSessionOptions<T>,
): T[] {
  return tools.filter((t) => includeToolForSession(t, opts));
}

export type RenderActiveModeToolsRegistryOptions = {
  workspace?: boolean;
  registeredNames?: readonly string[];
};

export function getModeRegistryDisplayLabel(mode: ModeRegistryKey): string {
  return MODE_LABELS[mode];
}

export function renderActiveModeToolsRegistry(
  mode: ModeRegistryKey,
  opts?: RenderActiveModeToolsRegistryOptions,
): string {
  const label = MODE_LABELS[mode];
  const lines: string[] = [`<tools_registry mode="${mode}" label="${label}">`];

  if (mode === "build" || mode === "debug") {
    lines.push(
      `Allowlist (${label}): all workspace tools; mutating tools use the approval queue.`,
    );
  } else {
    const allowlist = getModeToolAllowlist(mode).join(", ");
    lines.push(`Allowlist (${label}): ${allowlist}`);
  }

  if (opts?.workspace) {
    lines.push(
      "Workspace chat: this session is bound to an open project folder. Enabled MCP servers and installed skills are available via:",
    );
    lines.push(WORKSPACE_INTEGRATION_TOOL_NAMES.join(", "));
    lines.push(
      'Call list_available_mcps first, then mcp_call as needed. Skills are listed one line each under "Skills available" — read a skill\'s file with read_file when its line applies to the task; the bodies are not in your context.',
    );
  }

  if (opts?.registeredNames?.length) {
    lines.push(`Native schemas bound now: ${opts.registeredNames.join(", ")}`);
  }

  lines.push(
    "This turn's work mode is fixed until the user changes it in the UI; only tools on this allowlist can execute.",
  );

  lines.push("</tools_registry>");
  return lines.join("\n");
}
