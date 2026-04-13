/**
 * Tool allow-lists per skill (names must match ToolRegistry).
 */

import { ToolRegistry } from "../tools/registry";

export type ToolManifest = {
  allowed: string[];
  readOnly: boolean;
};

const ARCHITECT: ToolManifest = {
  allowed: [
    "read_file",
    "grep_search",
    "semantic_search",
    "get_blueprint",
    "add_blueprint_room",
    "add_blueprint_function",
    "add_blueprint_edge",
    "update_blueprint",
    "compare_blueprint_to_live",
    "get_diagram",
    "get_file_outline",
  ],
  readOnly: false,
};

const BUILDER: ToolManifest = {
  allowed: [
    "read_file",
    "write_file",
    "replace_code",
    "insert_code",
    "delete_lines",
    "edit_file_section",
    "run_command",
    "list_files",
    "find_file",
    "search_code",
    "grep_search",
    "semantic_search",
    "get_file_outline",
    "get_project_structure",
    "find_relevant_files",
  ],
  readOnly: false,
};

const REVIEWER: ToolManifest = {
  allowed: [
    "read_file",
    "grep_search",
    "semantic_search",
    "get_file_outline",
    "get_diagram",
  ],
  readOnly: true,
};

const DEBUGGER: ToolManifest = {
  allowed: [
    "read_file",
    "grep_search",
    "semantic_search",
    "diagnose_issue",
    "get_file_outline",
    "get_diagram",
    "read_url",
    "list_files",
    "find_file",
  ],
  readOnly: false,
};

const RESEARCHER: ToolManifest = {
  allowed: ["read_file", "web_search", "read_url", "grep_search"],
  readOnly: true,
};

const ORCHESTRATOR: ToolManifest = {
  allowed: ["read_file", "grep_search", "semantic_search", "message_agent"],
  readOnly: false,
};

const FOCUSED_WRITER: ToolManifest = BUILDER;

const FOCUSED_RESEARCHER: ToolManifest = RESEARCHER;

const manifests: Record<string, ToolManifest> = {
  "agents/architect": ARCHITECT,
  "agents/builder": BUILDER,
  "agents/reviewer": REVIEWER,
  "agents/debugger": DEBUGGER,
  "agents/researcher": RESEARCHER,
  "agents/orchestrator": ORCHESTRATOR,
  "subagents/focused-writer": FOCUSED_WRITER,
  "subagents/focused-researcher": FOCUSED_RESEARCHER,
  "modes/build-mode": {
    allowed: ["*"],
    readOnly: false,
  },
  "modes/debug-mode": {
    allowed: [
      "read_file",
      "grep_search",
      "semantic_search",
      "run_command",
      "write_file",
      "replace_code",
      "insert_code",
      "delete_lines",
      "edit_file_section",
      "get_blueprint",
      "get_diagram",
      "list_files",
      "find_file",
      "search_code",
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
