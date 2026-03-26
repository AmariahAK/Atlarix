/**
 * Agent mesh: direct agent-to-agent communication (AgentMessage), Main observes and can intervene.
 */

export type AgentId =
  | "main"
  | "architect"
  | "builder"
  | "reviewer"
  | "researcher"
  | "debugger";

export interface AgentMessage {
  id: string;
  from: AgentId;
  to: AgentId;
  type: "request" | "response" | "delegate" | "intervention";
  payload: unknown;
  timestamp: number;
  threadId?: string;
  chatId?: number;
}

type Listener = (msg: AgentMessage) => void;

const listeners: Listener[] = [];

/**
 * Publish a message on the agent bus (any agent or orchestrator).
 */
export function publishAgentMessage(msg: Omit<AgentMessage, "id" | "timestamp">): AgentMessage {
  const full: AgentMessage = {
    ...msg,
    id: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    timestamp: Date.now(),
  };
  listeners.forEach((fn) => {
    try {
      fn(full);
    } catch (e) {
      console.warn("[AgentBus] Listener error:", e);
    }
  });
  return full;
}

/**
 * Subscribe to all agent messages (e.g. orchestrator / Activity Stream).
 */
export function subscribeAgentBus(fn: Listener): () => void {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}
