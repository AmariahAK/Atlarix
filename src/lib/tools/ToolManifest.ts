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
  const onDemand: ToolMetadata[] = [];

  for (const tool of availableTools) {
    if (askMode && !(tool.isReadOnly || tool.allowInAskMode)) continue;
    if (isCoreTool(tool)) core.push(tool);
    else onDemand.push(tool);
  }

  let out = "## Available tools (call any by name when needed):\n";
  out += "### Core (always available):\n";
  for (const t of core) {
    out += `- ${t.name}: ${oneLineDescription(t)}\n`;
  }
  out += "\n### On demand (request when relevant):\n";
  for (const t of onDemand) {
    out += `- ${t.name}: ${oneLineDescription(t)}\n`;
  }
  out += "\nTo use any tool, simply call it. Full parameter details are provided when you invoke the tool.";
  out +=
    "\n\nGit operations: use **run_command** with git CLI (git status, git log, git diff). Do not read .git/objects manually.";
  return out;
}

export { CORE_TOOL_NAMES, isCoreTool };
