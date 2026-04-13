/**
 * Autonomous-only parallel specialist runs (research + architect) on top of the agent bus + runDelegation.
 */

import { publishAgentMessage, type AgentId } from "./agent-bus";
import { runDelegation } from "../tools/agent-tools";

export interface ParallelAgentTask {
  agentId: string;
  task: string;
  /** Correlates bus `task_assign` / orchestrator (always set for UI). */
  turnId: string;
  depth: number;
  chatId: number;
  workspacePath?: string;
  workspaceId?: number;
  /**
   * When false, delegation runs without ledger hooks (avoids racy writes when multiple
   * specialists run in parallel on the same parent turn).
   */
  recordOnParentLedger?: boolean;
}

export interface ParallelAgentResult {
  agentId: string;
  success: boolean;
  summary: string;
  structuredPayload?: unknown;
  error?: string;
}

export async function runAgentsInParallel(
  tasks: ParallelAgentTask[],
  timeoutMs: number = 120_000,
): Promise<ParallelAgentResult[]> {
  for (const task of tasks) {
    publishAgentMessage({
      from: "main",
      to: task.agentId as AgentId,
      type: "task_assign",
      content: task.task,
      turnId: task.turnId,
      depth: task.depth,
      chatId: task.chatId,
      payload: {},
    });
  }

  const promises = tasks.map(async (task) => {
    try {
      const result = await Promise.race([
        runDelegation({
          agent_id: task.agentId,
          task: task.task,
          depth: task.depth,
          chatId: task.chatId,
          workspace: task.workspacePath,
          workspaceId: task.workspaceId,
          turnId:
            task.recordOnParentLedger === false ? undefined : task.turnId,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Agent ${task.agentId} timed out after ${timeoutMs}ms`)),
            timeoutMs,
          ),
        ),
      ]);
      return {
        agentId: task.agentId,
        success: !!result.success,
        summary: result.summary ?? "",
        structuredPayload: result.structuredPayload,
      } satisfies ParallelAgentResult;
    } catch (err) {
      return {
        agentId: task.agentId,
        success: false,
        summary: "",
        error: err instanceof Error ? err.message : String(err),
      } satisfies ParallelAgentResult;
    }
  });

  return Promise.all(promises);
}

export function buildParallelContext(results: ParallelAgentResult[]): string {
  const sections = results.map((r) => {
    if (!r.success) {
      return `## ${r.agentId} (failed)\nError: ${r.error ?? "unknown"}`;
    }
    return `## ${r.agentId}\n${r.summary}`;
  });
  return sections.join("\n\n---\n\n");
}

export type OrchestrationPattern =
  | "sequential"
  | "research_then_build"
  | "build_then_verify";

export function classifyOrchestration(task: string, hasExistingPlan: boolean): OrchestrationPattern {
  if (hasExistingPlan) {
    return "build_then_verify";
  }

  const lower = task.toLowerCase();
  const needsResearch =
    lower.includes("how") ||
    lower.includes("research") ||
    lower.includes("find") ||
    lower.includes("look up") ||
    lower.includes("what is") ||
    lower.includes("integrate") ||
    lower.includes("using");

  if (needsResearch) {
    return "research_then_build";
  }

  return "sequential";
}
