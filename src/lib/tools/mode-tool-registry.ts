/**
 * Per-mode tool allowlists — single source of truth for prompts, native ToolSet
 * filtering, and execute-time gates.
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
  "call_webmcp_tool",
  "compress_context",
  "deep_research",
  "list_attachments",
  "list_webmcp_tools",
  "read_attachment",
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
  "ask_user",
  "browser_navigate",
  "browser_read_page",
  "browser_screenshot",
  "compress_context",
  "deep_research",
  "delegate_to_agent",
  "explore_folder",
  "find_file",
  "get_active_skills",
  "get_blueprint",
  "get_file_outline",
  "get_project_history",
  "get_project_structure",
  "get_repo_overview",
  "list_attachments",
  "list_available_mcps",
  "list_files",
  "list_installed_skills",
  "mcp_call",
  "memory",
  "read_attachment",
  "read_file",
  "read_url",
  "run_command",
  "search",
  "spawn_sub_agent",
  "task",
  "web_search",
] as const;

const PLAN_TOOLS = [
  "ask_user",
  "browser_navigate",
  "browser_read_page",
  "browser_screenshot",
  "compress_context",
  "edit_file",
  "explore_folder",
  "find_file",
  "get_active_skills",
  "get_blueprint",
  "get_file_outline",
  "get_plan_scope",
  "get_project_history",
  "get_project_structure",
  "get_repo_overview",
  "list_available_mcps",
  "list_files",
  "list_installed_skills",
  "mcp_call",
  "memory",
  "read_file",
  "read_implementation_plan",
  "run_command",
  "search",
  "update_plan_status",
  "update_plan_step",
  "write_file",
  "write_implementation_plan",
] as const;

const DEBUG_TOOLS = [
  "ask_user",
  "browser_click",
  "browser_fill",
  "browser_navigate",
  "browser_read_page",
  "browser_screenshot",
  "delete_file",
  "diagnose_issue",
  "edit_file",
  "explore_folder",
  "find_file",
  "get_active_skills",
  "get_blueprint",
  "get_file_outline",
  "get_project_structure",
  "get_repo_overview",
  "list_available_mcps",
  "list_files",
  "lsp_definitions",
  "lsp_diagnostics",
  "lsp_hover",
  "lsp_references",
  "mcp_call",
  "memory",
  "read_file",
  "record_debug_hypothesis",
  "rename_file",
  "run_command",
  "search",
  "stream_terminal_output",
  "write_file",
  "write_multiple_files",
] as const;

const REVIEW_TOOLS = [
  "ask_user",
  "browser_navigate",
  "browser_read_page",
  "browser_screenshot",
  "delegate_to_agent",
  "diagnose_issue",
  "explore_folder",
  "find_file",
  "get_active_skills",
  "get_blueprint",
  "get_file_outline",
  "get_project_history",
  "get_project_structure",
  "get_repo_overview",
  "list_available_mcps",
  "list_files",
  "list_installed_skills",
  "lsp_definitions",
  "lsp_diagnostics",
  "lsp_hover",
  "lsp_references",
  "mcp_call",
  "memory",
  "read_file",
  "run_command",
  "search",
  "spawn_sub_agent",
  "task",
] as const;

/** Full per-mode allowlists (mode-specific tools ∪ every-mode tools). */
const ASK_ALLOWLIST = withEveryModeTools(ASK_TOOLS);
const PLAN_ALLOWLIST = withEveryModeTools(PLAN_TOOLS);
const DEBUG_ALLOWLIST = withEveryModeTools(DEBUG_TOOLS);
const REVIEW_ALLOWLIST = withEveryModeTools(REVIEW_TOOLS);

/** Backward-compatible export for system_prompt and tests. */
export const MODE_SYSTEM_TOOL_LISTS = {
  ask: ASK_ALLOWLIST,
  plan: PLAN_ALLOWLIST,
  build: [BUILD_ALLOWLIST_MARKER] as const,
  debug: DEBUG_ALLOWLIST,
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
  debug: DEBUG_ALLOWLIST,
  review: REVIEW_ALLOWLIST,
};

let allowSetsCache: Record<ModeRegistryKey, Set<string>> | null = null;

function getAllowSets(): Record<ModeRegistryKey, Set<string>> {
  if (!allowSetsCache) {
    allowSetsCache = {
      ask: new Set(ASK_ALLOWLIST),
      plan: new Set(PLAN_ALLOWLIST),
      build: new Set(),
      debug: new Set(DEBUG_ALLOWLIST),
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
  if (mode === "build") return true;
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

  if (mode === "build") {
    lines.push(
      `Allowlist (${label}): all workspace tools (progressive reveal); mutating tools use the approval queue.`,
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
      "Call list_available_mcps / list_installed_skills first, then mcp_call or skill-backed tools as needed.",
    );
  }

  if (opts?.registeredNames?.length) {
    lines.push(
      `Native schemas bound now: ${opts.registeredNames.join(", ")}`,
    );
  }

  lines.push(
    "Progressive reveal: the allowlist above is what you may use in this work mode; native function schemas start with core tools (and workspace discovery tools when bound), then add each other allowlisted tool on first use in this chat session.",
  );
  lines.push(
    "This turn's work mode is fixed until the user changes it in the UI; only tools on this allowlist can execute.",
  );

  lines.push("</tools_registry>");
  return lines.join("\n");
}

