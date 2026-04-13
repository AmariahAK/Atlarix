/**
 * Orchestrator: Main observes agent-to-agent traffic and can intervene (inject message, redirect).
 */

import {
  publishAgentMessage,
  subscribeAgentBus,
  type AgentMessage,
  type AgentId,
  type AgentMessageInput,
} from "./agent-bus";

export type InterventionAction = "none" | "inject" | "redirect" | "block";

export interface OrchestratorDecision {
  action: InterventionAction;
  /** When action is inject: message to publish as Main */
  injectMessage?: AgentMessageInput;
  /** When action is redirect: override target agent */
  redirectTo?: AgentId;
}

let orchestratorHandler: ((msg: AgentMessage) => OrchestratorDecision) | null = null;

/**
 * Set the orchestrator handler. Main process or UI can set this to observe and optionally intervene.
 */
export function setOrchestratorHandler(
  handler: (msg: AgentMessage) => OrchestratorDecision | void,
): () => void {
  const fn = (msg: AgentMessage): OrchestratorDecision => {
    const decision = handler(msg);
    if (decision && decision.action !== "none") {
      if (decision.action === "inject" && decision.injectMessage) {
        publishAgentMessage({
          ...decision.injectMessage,
          from: "main",
          type: "intervention",
        });
      }
    }
    return decision ?? { action: "none" };
  };
  orchestratorHandler = fn;
  return () => {
    orchestratorHandler = null;
  };
}

/**
 * Notify the orchestrator of an agent message (called from bus subscription).
 */
export function notifyOrchestrator(msg: AgentMessage): void {
  if (orchestratorHandler) {
    try {
      orchestratorHandler(msg);
    } catch (e) {
      console.warn("[Orchestrator] Handler error:", e);
    }
  }
}

/**
 * Subscribe the orchestrator to the agent bus so it observes all traffic.
 */
export function startOrchestrator(): () => void {
  return subscribeAgentBus(notifyOrchestrator);
}

export interface OrchestratorTurnOptions {
  chatId: number;
  turnId: string;
  /** Surface blockers in the Activity Stream (renderer). */
  emitBlockerActivity: (label: string, detail?: string) => void;
  /**
   * Optional hook after main publishes a correction to the bus (e.g. extra UI).
   */
  onCorrectionNeeded?: (agentRole: AgentId, correctionText: string) => void;
}

const turnCorrectionEmitters = new Map<
  string,
  (agentRole: AgentId, correctionText: string) => void
>();

function turnCorrectionKey(chatId: number, turnId: string): string {
  return `${chatId}:${turnId}`;
}

/**
 * Emit a main→agent correction for an active autonomous turn (IPC / orchestrator logic).
 */
export function emitCorrectionForChatTurn(
  chatId: number,
  turnId: string,
  agentRole: AgentId,
  correctionText: string,
): void {
  turnCorrectionEmitters.get(turnCorrectionKey(chatId, turnId))?.(agentRole, correctionText);
}

export interface OrchestratorTurnHandle {
  stop: () => void;
  emitCorrection: (agentRole: AgentId, correctionText: string) => void;
}

/**
 * Scoped subscription: only messages for this chat + turnId. Surfaces `blocker` on Activity Stream.
 */
export function startOrchestratorForTurn(options: OrchestratorTurnOptions): OrchestratorTurnHandle {
  const { chatId, turnId, emitBlockerActivity, onCorrectionNeeded } = options;

  const emitCorrection = (agentRole: AgentId, correctionText: string) => {
    publishAgentMessage({
      from: "main",
      to: agentRole,
      type: "correction",
      content: correctionText,
      turnId,
      chatId,
      payload: {},
    });
    onCorrectionNeeded?.(agentRole, correctionText);
  };

  const k = turnCorrectionKey(chatId, turnId);
  turnCorrectionEmitters.set(k, emitCorrection);

  const unsub = subscribeAgentBus((msg: AgentMessage) => {
    if (msg.turnId !== turnId) return;
    if (msg.chatId != null && msg.chatId !== chatId) return;
    if (msg.type === "blocker") {
      const from = msg.from;
      const to = msg.to;
      const snippet = (msg.content ?? "").slice(0, 280);
      emitBlockerActivity(
        `Blocker: ${from} → ${to}`,
        snippet || (typeof msg.payload === "object" && msg.payload && "error" in msg.payload
          ? String((msg.payload as { error?: string }).error ?? "")
          : undefined),
      );
    }
  });

  return {
    stop: () => {
      turnCorrectionEmitters.delete(k);
      unsub();
    },
    emitCorrection,
  };
}
