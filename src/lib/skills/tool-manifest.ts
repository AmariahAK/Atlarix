/**
 * Tool allow-lists per skill (names must match ToolRegistry).
 *
 * Pass 7 + PASS6: Manifests track post-consolidation surface.
 *  - `search` is the unified codebase search (auto | text | semantic | structural).
 *  - `get_blueprint` returns a focused Blueprint graph slice (lazy parse).
 *  - edit_file replaces replace_code / insert_code / delete_lines / edit_file_section.
 *  - Inline \`\`\`graph\`\`\` JSON fences in chat for flows (or \`visualize_graph\` tool).
 */

import { ToolRegistry } from "../tools/registry";

export type ToolManifest = {
  allowed: string[];
  readOnly: boolean;
};

const ARCHITECT: ToolManifest = {
  allowed: [
    // PASS8 B2: get_workspace_overview removed (phantom — never registered).
    "read_file",
    "search",
    "get_blueprint",
    "get_file_outline",
    "visualize_graph",
  ],
  readOnly: true,
};

const BUILDER: ToolManifest = {
  allowed: [
    "read_file",
    "write_file",
    "edit_file",
    "run_command",
    "list_files",
    "find_file",
    "search",
    "get_blueprint",
    "get_file_outline",
    "get_project_structure",
  ],
  readOnly: false,
};

const REVIEWER: ToolManifest = {
  allowed: [
    "read_file",
    "search",
    "get_blueprint",
    "get_file_outline",
  ],
  readOnly: true,
};

const DEBUGGER: ToolManifest = {
  allowed: [
    "read_file",
    "search",
    "get_blueprint",
    "diagnose_issue",
    "get_file_outline",
    "read_url",
    "list_files",
    "find_file",
    "stream_terminal_output",
    "list_terminal_instances",
    "read_terminal_instance",
    "open_terminal_instance",
    "close_terminal_instance",
  ],
  readOnly: false,
};

const RESEARCHER: ToolManifest = {
  allowed: [
    "read_file",
    "explore_folder",
    "list_files",
    "get_repo_overview",
    "search",
    "web_search",
    "deep_research",
    "read_url",
    "visualize_graph",
  ],
  readOnly: true,
};

const EXPLORER: ToolManifest = {
  allowed: [
    "read_file",
    "search",
    "get_blueprint",
    "get_file_outline",
    "list_files",
    "find_file",
  ],
  readOnly: true,
};

const SCOUT: ToolManifest = {
  allowed: [
    "read_file",
    "search",
    "get_blueprint",
    "get_file_outline",
    "list_files",
    "find_file",
    "web_search",
    "deep_research",
    "read_url",
  ],
  readOnly: true,
};

const ORCHESTRATOR: ToolManifest = {
  allowed: ["read_file", "search", "message_agent"],
  readOnly: false,
};

const FOCUSED_WRITER: ToolManifest = BUILDER;

const FOCUSED_RESEARCHER: ToolManifest = RESEARCHER;

const FOCUSED_EXPLORER: ToolManifest = EXPLORER;

const manifests: Record<string, ToolManifest> = {
  "agents/architect": ARCHITECT,
  "agents/builder": BUILDER,
  "agents/reviewer": REVIEWER,
  "agents/debugger": DEBUGGER,
  "agents/researcher": RESEARCHER,
  "agents/explorer": EXPLORER,
  "agents/scout": SCOUT,
  "agents/orchestrator": ORCHESTRATOR,
  "subagents/focused-writer": FOCUSED_WRITER,
  "subagents/focused-researcher": FOCUSED_RESEARCHER,
  "subagents/focused-explorer": FOCUSED_EXPLORER,
  "modes/build-mode": {
    allowed: ["*"],
    readOnly: false,
  },
  "modes/debug-mode": {
    allowed: [
      "ask_user",
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
      "list_terminal_instances",
      "read_terminal_instance",
      "open_terminal_instance",
      "close_terminal_instance",
      "write_file",
      "write_multiple_files",
    ],
    readOnly: false,
  },
};

export function getToolManifest(skillName: string): ToolManifest {
  if (skillName === "modes/ask-mode") {
    return {
      allowed: ToolRegistry.getToolsForAskMode().map((t) => t.name),
      readOnly: true,
    };
  }
  if (skillName === "modes/plan-mode") {
    return {
      allowed: ToolRegistry.getAll()
        .filter(
          (t) =>
            t.isReadOnly === true ||
            t.allowInAskMode === true ||
            t.name === "write_implementation_plan",
        )
        .map((t) => t.name),
      readOnly: false,
    };
  }
  if (skillName === "modes/review-mode") {
    return {
      allowed: ToolRegistry.getToolsForAskMode().map((t) => t.name),
      readOnly: true,
    };
  }
  return (
    manifests[skillName] ?? {
      allowed: ["read_file"],
      readOnly: true,
    }
  );
}
