/**
 * Tool Manifest — v4.0 Progressive Tool Reveal
 * Generates a compact one-line-per-tool manifest for the system prompt.
 */

import type { ToolMetadata } from "./registry";

const CORE_TOOL_NAMES = new Set([
  "read_file",
  "explore_folder",
  "write_file",
  "run_command",
  "search",
  "get_blueprint",
  "get_project_structure",
]);

/** MCP + installed-skills discovery tools pre-registered for workspace-bound chats. */
export const WORKSPACE_INTEGRATION_TOOL_NAMES = [
  "list_available_mcps",
  "mcp_call",
  "list_installed_skills",
  "get_active_skills",
] as const;

const WORKSPACE_INTEGRATION_TOOL_SET = new Set<string>(
  WORKSPACE_INTEGRATION_TOOL_NAMES,
);

export function isWorkspaceIntegrationTool(name: string): boolean {
  return WORKSPACE_INTEGRATION_TOOL_SET.has(name);
}

function isCoreTool(tool: ToolMetadata): boolean {
  return CORE_TOOL_NAMES.has(tool.name) || tool.isCore === true;
}

/**
 * Generate a short one-line description for the manifest (no full schema).
 */
function oneLineDescription(tool: ToolMetadata): string {
  const d = tool.description;
  const first = d.split(/[.!]/)[0].trim();
  return first.length > 80 ? first.slice(0, 77) + "..." : first;
}

/**
 * Generate manifest string for system prompt.
 * @param availableTools - Tools available to this user/mode (e.g. Ask vs Build filtered)
 * @param askMode - If true, only include read-only tools in the manifest
 */
export function generateManifest(
  availableTools: ToolMetadata[],
  askMode: boolean
): string {
  const core: ToolMetadata[] = [];

  for (const tool of availableTools) {
    if (askMode && !(tool.isReadOnly || tool.allowInAskMode)) continue;
    if (isCoreTool(tool)) core.push(tool);
  }

  let out = "## Core tools (registered for native function calling):\n";
  for (const t of core) {
    out += `- ${t.name}: ${oneLineDescription(t)}\n`;
  }
  out +=
    "\nUse the registered function tools above. Additional tools load automatically when first invoked — do not emit XML tool syntax in visible text.";
  out +=
    "\n\nGit operations: use **run_command** with git CLI (git status, git log, git diff). Do not read .git/objects manually.";
  return out;
}

/**
 * Compact note when the full tools_registry block is already in the system header.
 */
export function generateProgressiveRevealNote(
  registeredNames: readonly string[],
  mode: string,
): string {
  if (registeredNames.length === 0) {
    return `## Native tools (${mode})\nProgressive reveal: core tools bind first; other allowlist tools load on first use. See <tools_registry> in the system prompt.`;
  }
  return `## Native tools bound (${mode})\n${registeredNames.join(", ")}\nAdditional allowlist tools load automatically on first invoke.`;
}

export { CORE_TOOL_NAMES, isCoreTool };
