/**
 * Tool surface helpers (v13) — core-tool classification + workspace
 * integration (MCP) discovery tools. Progressive reveal is gone: the full
 * ~22-tool surface binds upfront.
 */

import type { ToolMetadata } from "./registry";

const CORE_TOOL_NAMES = new Set([
  "read_file",
  // v13.8: write_file merged into edit_file (operation:"write").
  "edit_file",
  "glob",
  "grep",
  "run_command",
]);

/** MCP discovery tools pre-registered for workspace-bound chats. */
export const WORKSPACE_INTEGRATION_TOOL_NAMES = [
  "list_available_mcps",
  "mcp_call",
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

export { CORE_TOOL_NAMES, isCoreTool };
