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
  // is every mode. (background_jobs is withheld from Plan because Plan can't
  // run commands; Plan CAN delegate read-only recon and web research, so it
  // must be able to list, read, and cancel what it delegated.)
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
] as const;

function withEveryModeTools(list: readonly string[]): readonly string[] {
  return Object.freeze(
    [...new Set([...list, ...EVERY_MODE_TOOLS])].sort((a, b) =>
      a.localeCompare(b),
    ),
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
  "mcp_call",
  "read_file",
  "run_command",
  "task",
] as const;

// Plan mode is filesystem-read-only: it authors its PLAN via the `plan` tool
// (session artifact) but must NOT touch the workspace. edit_file (except the
// .atlarix docs) / destructive run_command stay excluded from the advertised
// list and the execute-gate (incl. the text-tool fallback path).
const PLAN_TOOLS = [
  "automations",
  "browser",
  "browser_inspect",
  "glob",
  "grep",
  "list_available_mcps",
  "mcp_call",
  "plan",
  "read_file",
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
  "mcp_call",
  "read_file",
  "run_command",
  "task",
] as const;

/** Full per-mode allowlists (mode-specific tools ∪ every-mode tools). */
const ASK_ALLOWLIST = withEveryModeTools(ASK_TOOLS);
const PLAN_ALLOWLIST = withEveryModeTools(PLAN_TOOLS);
const REVIEW_ALLOWLIST = withEveryModeTools(REVIEW_TOOLS);

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
