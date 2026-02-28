/**
 * Plan card data and renderer: parse plan from message content for display below AI responses.
 */

export type PlanTaskStatus = "pending" | "in_progress" | "done" | "failed";

export type PlanAgentId = "main" | "architect" | "builder" | "reviewer" | "researcher";

export interface PlanTask {
  id: string;
  label: string;
  status: PlanTaskStatus;
  agentId?: PlanAgentId;
}

export interface PlanTaskGroup {
  id: string;
  title: string;
  tasks: PlanTask[];
  agentId?: PlanAgentId;
}

export interface PlanCardData {
  taskGroups: PlanTaskGroup[];
  completed?: boolean;
}

const PLAN_BLOCK_RE = /<atlarix-plan[^>]*>([\s\S]*?)<\/atlarix-plan>/i;
const JSON_PLAN_RE = /```(?:json)?\s*plan\s*([\s\S]*?)```/i;

function parseJsonPlan(raw: string): PlanCardData | null {
  try {
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object") return null;
    const obj = data as Record<string, unknown>;
    const taskGroups = obj.taskGroups as PlanTaskGroup[] | undefined;
    if (!Array.isArray(taskGroups)) return null;
    const out: PlanCardData = {
      taskGroups: taskGroups.map((g) => ({
        id: String(g.id ?? Math.random().toString(36).slice(2)),
        title: String(g.title ?? "Tasks"),
        tasks: Array.isArray(g.tasks)
          ? (g.tasks as PlanTask[]).map((t) => ({
              id: String(t.id ?? Math.random().toString(36).slice(2)),
              label: String(t.label ?? ""),
              status: ["pending", "in_progress", "done", "failed"].includes(String(t.status))
                ? (t.status as PlanTaskStatus)
                : "pending",
              agentId: (t.agentId ?? g.agentId) as PlanAgentId | undefined,
            }))
          : [],
      })),
    };
    if (typeof obj.completed === "boolean") out.completed = obj.completed;
    return out;
  } catch {
    return null;
  }
}

/**
 * Extract plan card data from assistant message content (custom tag or fenced block).
 */
export function extractPlanFromContent(content: string): PlanCardData | null {
  if (!content || typeof content !== "string") return null;
  let raw: string | null = null;
  const tagMatch = content.match(PLAN_BLOCK_RE);
  if (tagMatch) raw = tagMatch[1].trim();
  if (!raw) {
    const codeMatch = content.match(JSON_PLAN_RE);
    if (codeMatch) raw = codeMatch[1].trim();
  }
  if (!raw) return null;
  return parseJsonPlan(raw);
}
