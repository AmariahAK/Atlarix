/**
 * Parallel specialist runs via runDelegation (no agent bus).
 */

import { runDelegation } from "../tools/agent";

/** Cap concurrent delegated runs to limit peak RSS / V8 pressure during autonomous workflows. */
const MAX_PARALLEL_AGENT_RUNS = 2;

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
  const results: ParallelAgentResult[] = [];
  for (let i = 0; i < tasks.length; i += MAX_PARALLEL_AGENT_RUNS) {
    const slice = tasks.slice(i, i + MAX_PARALLEL_AGENT_RUNS);

    const sliceResults = await Promise.all(
      slice.map(async (task) => {
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
                () =>
                  reject(
                    new Error(
                      `Agent ${task.agentId} timed out after ${timeoutMs}ms`,
                    ),
                  ),
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
      }),
    );
    results.push(...sliceResults);
  }
  return results;
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
