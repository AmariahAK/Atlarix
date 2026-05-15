export type AgentSkillName =
  | "agents/architect"
  | "agents/builder"
  | "agents/reviewer"
  | "agents/debugger"
  | "agents/researcher"
  | "agents/explorer"
  | "agents/scout"
  | "agents/orchestrator"
  | "subagents/focused-writer"
  | "subagents/focused-researcher"
  | "subagents/focused-explorer";

export type ModeSkillName =
  | "modes/ask-mode"
  | "modes/plan-mode"
  | "modes/build-mode"
  | "modes/debug-mode"
  | "modes/review-mode";

/** Builtin specialist ids for `delegate_to_agent` and work-mode defaults. */
export type DelegationAgentId =
  | "research"
  | "explore"
  | "scout"
  | "architect"
  | "builder"
  | "reviewer"
  | "debugger";

export interface AgentMetadata {
  id: DelegationAgentId;
  name: string;
  description: string;
  /** Lucide icon name for UI / activity stream */
  icon: string;
  skillName: AgentSkillName;
}

export const AGENT_REGISTRY: Record<DelegationAgentId, AgentMetadata> = {
  research: {
    id: "research",
    name: "Research",
    description: "Web search, docs, fact-finding",
    icon: "Search",
    skillName: "agents/researcher",
  },
  explore: {
    id: "explore",
    name: "Explore",
    description: "Read-only repo mapping and codebase Q&A",
    icon: "Map",
    skillName: "agents/explorer",
  },
  scout: {
    id: "scout",
    name: "Scout",
    description: "Dependency traces + targeted web/docs context",
    icon: "Radar",
    skillName: "agents/scout",
  },
  architect: {
    id: "architect",
    name: "Architect",
    description: "Design and architecture",
    icon: "Box",
    skillName: "agents/architect",
  },
  builder: {
    id: "builder",
    name: "Builder",
    description: "Code implementation",
    icon: "Hammer",
    skillName: "agents/builder",
  },
  reviewer: {
    id: "reviewer",
    name: "Reviewer",
    description: "Review, security, best practices",
    icon: "Eye",
    skillName: "agents/reviewer",
  },
  debugger: {
    id: "debugger",
    name: "Debugger",
    description: "Errors, traces, root-cause analysis",
    icon: "Bug",
    skillName: "agents/debugger",
  },
};

export function getAgentMetadata(agentId: string): AgentMetadata | undefined {
  return AGENT_REGISTRY[agentId as DelegationAgentId];
}

export function getSkillNameForAgent(agentId: string): AgentSkillName {
  return getAgentMetadata(agentId)?.skillName ?? "agents/builder";
}

/** Narrow subagent skills for nested delegation (depth > 0). */
export function getFocusedSkillNameForAgent(agentId: string): AgentSkillName {
  if (agentId === "builder" || agentId === "architect") {
    return "subagents/focused-writer";
  }
  if (agentId === "research" || agentId === "scout") {
    return "subagents/focused-researcher";
  }
  if (agentId === "explore") {
    return "subagents/focused-explorer";
  }
  return getSkillNameForAgent(agentId);
}

const MODE_MAP: Record<string, ModeSkillName> = {
  ask: "modes/ask-mode",
  plan: "modes/plan-mode",
  build: "modes/build-mode",
  agent: "modes/build-mode",
  debug: "modes/debug-mode",
  review: "modes/review-mode",
};

/** `selectedChatMode` / work-mode string; `agent` maps to build-mode skill. */
export function getSkillNameForMode(mode: string): ModeSkillName {
  return MODE_MAP[mode] ?? "modes/build-mode";
}
