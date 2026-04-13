/**
 * Agent mesh: direct agent-to-agent communication (AgentMessage), Main observes and can intervene.
 *
 * **Bus contract:** `publishAgentMessage` runs synchronously: it notifies all subscribers in-process.
 * Listeners must not perform heavy async work inline (schedule work instead). Never `await`
 * `publishAgentMessage` — it is not async and must stay non-blocking for stream and tool loops.
 */

export type AgentId =
  | "main"
  | "architect"
  | "builder"
  | "reviewer"
  | "research"
  | "researcher"
  | "debugger";

export type AgentMessageType =
  | "request"
  | "response"
  | "delegate"
  | "intervention"
  | "task_assign"
  | "task_result"
  | "blocker"
  | "correction"
  | "question"
  | "answer"
  | "status";

export interface AgentMessage {
  id: string;
  from: AgentId;
  to: AgentId;
  type: AgentMessageType;
  payload: unknown;
  timestamp: number;
  threadId?: string;
  chatId?: number;
  /** Conversation turn (assistant message id) for scoping orchestrator and review. */
  turnId?: string;
  depth?: number;
  parentMessageId?: string;
  /** Human-readable body when payload is not enough for Activity Stream. */
  content?: string;
}

/** Alias for AgentMessage (bus / mesh traffic). */
export type BusMessage = AgentMessage;

export type AgentMessageInput = Omit<AgentMessage, "id" | "timestamp"> & { id?: string };

type Listener = (msg: AgentMessage) => void;

const listeners: Listener[] = [];

/** Pending main→agent corrections per turn and recipient (drained between delegation tool steps). */
const correctionQueues = new Map<string, string[]>();

function correctionQueueKey(turnId: string, toAgent: AgentId): string {
  return `${turnId}:${toAgent}`;
}

export function drainAgentCorrections(turnId: string, toAgent: AgentId): string[] {
  const k = correctionQueueKey(turnId, toAgent);
  const batch = correctionQueues.get(k) ?? [];
  correctionQueues.delete(k);
  return batch;
}

/** Map builtin specialist id to bus AgentId (research and researcher both valid). */
export function toAgentId(role: string): AgentId {
  const r = role.toLowerCase();
  if (r === "main") return "main";
  if (r === "research" || r === "researcher") return "research";
  if (r === "architect") return "architect";
  if (r === "builder") return "builder";
  if (r === "reviewer") return "reviewer";
  if (r === "debugger") return "debugger";
  return "builder";
}

/** Build a bus message with `id` and `timestamp` (same scheme as {@link publishAgentMessage}); does not notify listeners. */
export function createBusMessage(msg: AgentMessageInput): AgentMessage {
  return {
    ...msg,
    id: msg.id ?? `agent-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    timestamp: Date.now(),
  };
}

/**
 * Publish a message on the agent bus (any agent or orchestrator).
 * Pass `id` to correlate replies (e.g. message_agent); otherwise an id is generated.
 *
 * Synchronous: pushes to subscriber callbacks immediately. Subscribers own any async follow-up.
 */
export function publishAgentMessage(msg: AgentMessageInput): AgentMessage {
  const full = createBusMessage(msg);
  if (full.type === "correction" && full.turnId && full.content) {
    const k = correctionQueueKey(full.turnId, full.to);
    const arr = correctionQueues.get(k) ?? [];
    arr.push(full.content);
    correctionQueues.set(k, arr);
  }
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

/**
 * Wait for a bus message that replies to a message_agent send (type "answer", matching parentMessageId).
 */
export function waitForBusReply(
  parentMessageId: string,
  match: {
    expectFrom: AgentId;
    expectTo: AgentId;
    timeoutMs?: number;
  },
): Promise<AgentMessage | null> {
  const timeoutMs = match.timeoutMs ?? 10_000;
  return new Promise((resolve) => {
    let settled = false;
    const done = (msg: AgentMessage | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        unsubscribe();
      } catch {
        /* noop */
      }
      resolve(msg);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    const unsubscribe = subscribeAgentBus((msg: AgentMessage) => {
      if (
        msg.parentMessageId === parentMessageId &&
        msg.from === match.expectFrom &&
        msg.to === match.expectTo &&
        msg.type === "answer"
      ) {
        done(msg);
      }
    });
  });
}
