/**
 * Plan card data and renderer: parse plan from message content for display below AI responses.
 */

export type PlanTaskStatus = "pending" | "in_progress" | "done" | "failed";

export type PlanAgentId =
  | "main"
  | "architect"
  | "builder"
  | "reviewer"
  | "researcher"
  | "debugger";

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
const PLAN_COMMENT_RE = /<!--\s*atlarix-plan:\s*([\s\S]*?)\s*-->/i;
const PLAN_REPORT_RE = /##\s*Plan Report([\s\S]*?)(?:\n##\s|\n#\s|$)/i;

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

function toTaskId(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "task";
}

function parsePlanReport(content: string): PlanCardData | null {
  const reportMatch = content.match(PLAN_REPORT_RE);
  if (!reportMatch?.[1]) return null;
  const reportBody = reportMatch[1];

  const phaseLines = Array.from(
    reportBody.matchAll(/^- \*\*(.+?)\*\* \((.+?)\):\s*(.+)$/gm),
  );

  if (phaseLines.length > 0) {
    const taskGroups: PlanTaskGroup[] = phaseLines.map((m, i) => {
      const title = (m[1] || "").trim();
      const phaseId = (m[2] || "").trim() || `phase-${i + 1}`;
      const tasksRaw = (m[3] || "")
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
      return {
        id: phaseId,
        title,
        tasks: tasksRaw.map((label, j) => ({
          id: `${phaseId}-${toTaskId(label)}-${j + 1}`,
          label,
          status: "pending",
        })),
      };
    });
    return { taskGroups, completed: false };
  }

  // Fallback for generic markdown plans: collect top-level bullets under Plan Report.
  const genericTasks = Array.from(reportBody.matchAll(/^- (.+)$/gm))
    .map((m) => (m[1] || "").trim())
    .filter(Boolean);
  if (genericTasks.length === 0) return null;
  return {
    taskGroups: [
      {
        id: "plan",
        title: "Implementation Plan",
        tasks: genericTasks.map((label, i) => ({
          id: `plan-${toTaskId(label)}-${i + 1}`,
          label,
          status: "pending",
        })),
      },
    ],
    completed: false,
  };
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
    const commentMatch = content.match(PLAN_COMMENT_RE);
    if (commentMatch) raw = commentMatch[1].trim();
  }
  if (!raw) {
    const codeMatch = content.match(JSON_PLAN_RE);
    if (codeMatch) raw = codeMatch[1].trim();
  }
  if (raw) {
    const parsed = parseJsonPlan(raw);
    if (parsed) return parsed;
  }
  return parsePlanReport(content);
}

/**
 * Remove plan payload / duplicate plan prose from the assistant message so the chat
 * body does not repeat markdown that is already shown in the Plan card.
 */
export function stripAssistantPlanForDisplay(content: string): string {
  if (!content || typeof content !== "string") return "";
  let out = content;
  out = out.replace(/<!--\s*atlarix-plan:\s*[\s\S]*?\s*-->/gi, "");
  out = out.replace(PLAN_BLOCK_RE, "");
  out = out.replace(JSON_PLAN_RE, "");
  out = out.replace(PLAN_REPORT_RE, "");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}
