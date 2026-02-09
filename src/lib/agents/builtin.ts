/**
 * v2.1: Built-in agents (Research, Architect, Builder, Reviewer).
 * No emojis; use Lucide icon names in UI (Search, Box, Hammer, Eye).
 */

export const BUILTIN_AGENT_IDS = ["research", "architect", "builder", "reviewer"] as const;
export type BuiltinAgentId = (typeof BUILTIN_AGENT_IDS)[number];

export interface BuiltinAgent {
  id: BuiltinAgentId;
  name: string;
  description: string;
  /** Lucide icon name for UI and Activity Stream */
  icon: string;
  /** Tool names this agent can use (must exist in ToolRegistry) */
  toolSet: string[];
  systemPrompt: string;
}

const RESEARCH_SYSTEM = `You are the Research specialist. Your job is to find information: web search, docs, fact-finding.
Use read_file, web_search, read_url, grep_search to gather facts. Return a concise summary and sources.`;

const ARCHITECT_SYSTEM = `You are the Architect specialist. Your job is design, Blueprint, and architecture.
Use read_file, grep_search, semantic_search, and diagram/blueprint tools. Propose structure and high-level design; do not implement code.`;

const BUILDER_SYSTEM = `You are the Builder specialist. Your job is code implementation.
Use write_file, replace_code, insert_code, run_command, and other code tools to implement changes. Follow the plan; keep changes focused.`;

const REVIEWER_SYSTEM = `You are the Reviewer specialist. Your job is review, security, and best practices.
Use read_file, grep_search, semantic_search only (read-only). Report issues and suggestions; do not edit files.`;

export const BUILTIN_AGENTS: Record<BuiltinAgentId, BuiltinAgent> = {
  research: {
    id: "research",
    name: "Research",
    description: "Web search, docs, fact-finding",
    icon: "Search",
    toolSet: ["read_file", "web_search", "read_url", "grep_search"],
    systemPrompt: RESEARCH_SYSTEM,
  },
  architect: {
    id: "architect",
    name: "Architect",
    description: "Design, Blueprint, architecture",
    icon: "Box",
    toolSet: [
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
    systemPrompt: ARCHITECT_SYSTEM,
  },
  builder: {
    id: "builder",
    name: "Builder",
    description: "Code implementation",
    icon: "Hammer",
    toolSet: [
      "read_file",
      "write_file",
      "replace_code",
      "insert_code",
      "delete_lines",
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
    systemPrompt: BUILDER_SYSTEM,
  },
  reviewer: {
    id: "reviewer",
    name: "Reviewer",
    description: "Review, security, best practices",
    icon: "Eye",
    toolSet: ["read_file", "grep_search", "semantic_search", "get_file_outline", "get_diagram"],
    systemPrompt: REVIEWER_SYSTEM,
  },
};

export function getBuiltinAgent(id: string): BuiltinAgent | undefined {
  if (BUILTIN_AGENT_IDS.includes(id as BuiltinAgentId)) {
    return BUILTIN_AGENTS[id as BuiltinAgentId];
  }
  return undefined;
}

export function getAllBuiltinAgents(): BuiltinAgent[] {
  return BUILTIN_AGENT_IDS.map((id) => BUILTIN_AGENTS[id]);
}
