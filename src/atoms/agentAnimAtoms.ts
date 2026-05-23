import { atom } from "jotai";
import { getDefaultStore } from "jotai";

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

const INITIAL_AGENT_STATES: Record<AgentId, AgentAnimState> = {
  main: "idle",
  architect: "idle",
  builder: "idle",
  reviewer: "idle",
  researcher: "idle",
  debugger: "idle",
};

export const agentAnimStatesAtom = atom<Record<AgentId, AgentAnimState>>({
  ...INITIAL_AGENT_STATES,
});

export const agentActiveFlowsAtom = atom<MessageFlowState[]>([]);

export function setAgentAnimState(agentId: AgentId, state: AgentAnimState): void {
  getDefaultStore().set(agentAnimStatesAtom, (prev) => ({
    ...prev,
    [agentId]: state,
  }));
}

export function startAgentFlow(flow: MessageFlowState): void {
  getDefaultStore().set(agentActiveFlowsAtom, (prev) => [
    ...prev.filter((f) => f.id !== flow.id),
    flow,
  ]);
}

export function endAgentFlow(id: string): void {
  getDefaultStore().set(agentActiveFlowsAtom, (prev) => prev.filter((f) => f.id !== id));
}

/** Fixed positions for agent canvas (build guide). */
export const AGENT_CANVAS_POSITIONS: Record<AgentId, { x: number; y: number }> = {
  main: { x: 300, y: 50 },
  researcher: { x: 100, y: 200 },
  architect: { x: 300, y: 200 },
  builder: { x: 500, y: 200 },
  reviewer: { x: 300, y: 350 },
  debugger: { x: 500, y: 350 },
};
