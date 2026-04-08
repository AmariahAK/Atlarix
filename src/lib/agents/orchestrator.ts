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
   * Publish a correction to an agent on the bus (from main).
   * Reserved for future orchestrator logic / UI triggers.
   */
  onCorrectionNeeded?: (agentRole: AgentId, correctionText: string) => void;
}

/**
 * Scoped subscription: only messages for this chat + turnId. Surfaces `blocker` on Activity Stream.
 */
export function startOrchestratorForTurn(options: OrchestratorTurnOptions): () => void {
  const { chatId, turnId, emitBlockerActivity, onCorrectionNeeded } = options;
  void onCorrectionNeeded;

  return subscribeAgentBus((msg: AgentMessage) => {
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
}
