/**
 * Per-mode tool allowlists — single source of truth for prompts, native ToolSet
 * filtering, and execute-time gates.
 *
 * THE TOOL-RESOLUTION PIPELINE (v12 3.10 — one documented order, four stages):
 *   1. registry metadata   — ToolRegistry (registry.ts): per-tool flags
 *      (isReadOnly / allowInAskMode / requiresWorkspace / isCore / cost)
 *   2. mode allowlist      — THIS FILE: includeToolForSession / allow-sets
 *   3. session loader      — ToolSessionLoader: progressive reveal (core
 *      pre-loaded, others on first call)
 *   4. capability trim     — model-capability-profile.ts (v12 2.1): per-model
 *      cap + schema simplification for clearly-weak models. LAST stage; the
 *      offered set is what survives all four.
 * Execute-time gating re-checks stage 2 (and the permission layer) — a tool
 * that is not offered can still be DENIED if a model hallucinates a call.
 *
 * v12 S19 (3.10 CLOSED): the pipeline is ASSEMBLED in exactly one place —
 * `resolveToolsetForSession` (resolve-toolset.ts). Both stream branches call
 * it; the exact offered surface per mode is pinned by the toolset-golden eval.
 */

import type { WorkMode } from "@/lib/schemas";
import {
  isWorkspaceIntegrationTool,
  WORKSPACE_INTEGRATION_TOOL_NAMES,
} from "./ToolManifest";

export type ModeRegistryKey = WorkMode;

/** Documented in registry text when mode is build (all tools via progressive reveal). */
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
] as const;

function withEveryModeTools(list: readonly string[]): readonly string[] {
  return Object.freeze(
    [...new Set([...list, ...EVERY_MODE_TOOLS])].sort((a, b) =>
      a.localeCompare(b),
    ),
  );
}

const ASK_TOOLS = [
  "browser_navigate",
  "browser_read_page",
  "browser_screenshot",
  "get_blueprint",
  "glob",
  "grep",
  "list_available_mcps",
  "mcp_call",
  "read_file",
  "run_command",
  "task",
] as const;

// Plan mode is filesystem-read-only: it authors its PLAN via the `plan` tool
// (session artifact) but must NOT touch the workspace. write_file / edit_file /
// destructive run_command stay excluded from the advertised list and the
// execute-gate (incl. the text-tool fallback path).
const PLAN_TOOLS = [
  "browser_navigate",
  "browser_read_page",
  "browser_screenshot",
  "get_blueprint",
  "glob",
  "grep",
  "list_available_mcps",
  "mcp_call",
  "plan",
  "read_file",
  "task",
] as const;

const REVIEW_TOOLS = [
  "browser_navigate",
  "browser_read_page",
  "browser_screenshot",
  "get_blueprint",
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

const MODE_LABELS: Record<ModeRegistryKey, string> = {
  ask: "Explore",
  plan: "Plan",
  build: "Build",
  debug: "Fix",
  review: "Review",
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
  const lines: string[] = [
    `<tools_registry mode="${mode}" label="${label}">`,
  ];

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
      "Call list_available_mcps first, then mcp_call as needed. Installed skills are injected into your context automatically.",
    );
  }

  if (opts?.registeredNames?.length) {
    lines.push(
      `Native schemas bound now: ${opts.registeredNames.join(", ")}`,
    );
  }

  lines.push(
    "This turn's work mode is fixed until the user changes it in the UI; only tools on this allowlist can execute.",
  );

  lines.push("</tools_registry>");
  return lines.join("\n");
}

