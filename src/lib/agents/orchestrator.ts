/**
 * Orchestrator: Main observes agent-to-agent traffic and can intervene (inject message, redirect).
 */

import { publishAgentMessage, subscribeAgentBus, type AgentMessage, type AgentId } from "./agent-bus";

export type InterventionAction = "none" | "inject" | "redirect" | "block";

export interface OrchestratorDecision {
  action: InterventionAction;
  /** When action is inject: message to publish as Main */
  injectMessage?: Omit<AgentMessage, "id" | "timestamp">;
  /** When action is redirect: override target agent */
  redirectTo?: AgentId;
}

let orchestratorHandler: ((msg: AgentMessage) => OrchestratorDecision) | null = null;

/**
 * Set the orchestrator handler. Main process or UI can set this to observe and optionally intervene.
 */
export function setOrchestratorHandler(handler: (msg: AgentMessage) => OrchestratorDecision | void): () => void {
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
      // redirect/block would be applied by the caller when processing the decision
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
