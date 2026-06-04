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
