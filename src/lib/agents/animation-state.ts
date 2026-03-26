/**
 * Agent animation: Zustand store as single source of truth for agent canvas state.
 * Used by AgentNode and AgentMessageEdge; updated from Activity Stream / AgentBus.
 */

import { create } from "zustand";

export type AgentId =
  | "main"
  | "architect"
  | "builder"
  | "reviewer"
  | "researcher"
  | "debugger";

export type AgentAnimState =
  | "idle"
  | "thinking"
  | "delegating"
  | "reviewing"
  | "waiting"
  | "error"
  | "done";

export interface MessageFlowState {
  id: string;
  from: AgentId;
  to: AgentId;
  type: "request" | "response" | "review" | "fix";
  startedAt: number;
}

interface AgentAnimStore {
  agentStates: Record<AgentId, AgentAnimState>;
  activeFlows: MessageFlowState[];
  setAgentState: (agentId: AgentId, state: AgentAnimState) => void;
  startFlow: (flow: MessageFlowState) => void;
  endFlow: (id: string) => void;
}

const DEFAULT_AGENT_STATE: AgentAnimState = "idle";

const INITIAL_AGENT_STATES: Record<AgentId, AgentAnimState> = {
  main: "idle",
  architect: "idle",
  builder: "idle",
  reviewer: "idle",
  researcher: "idle",
  debugger: "idle",
};

export const useAgentAnimStore = create<AgentAnimStore>((set) => ({
  agentStates: { ...INITIAL_AGENT_STATES },
  activeFlows: [],

  setAgentState: (agentId, state) =>
    set((s) => ({
      agentStates: { ...s.agentStates, [agentId]: state },
    })),

  startFlow: (flow) =>
    set((s) => ({
      activeFlows: [...s.activeFlows.filter((f) => f.id !== flow.id), flow],
    })),

  endFlow: (id) =>
    set((s) => ({
      activeFlows: s.activeFlows.filter((f) => f.id !== id),
    })),
}));

/** Fixed positions for agent canvas (build guide). */
export const AGENT_CANVAS_POSITIONS: Record<AgentId, { x: number; y: number }> = {
  main: { x: 300, y: 50 },
  researcher: { x: 100, y: 200 },
  architect: { x: 300, y: 200 },
  builder: { x: 500, y: 200 },
  reviewer: { x: 300, y: 350 },
  debugger: { x: 500, y: 350 },
};
