/**
 * Plan card data and renderer: parse plan from message content for display below AI responses.
 */

export type PlanTaskStatus = "pending" | "in_progress" | "done" | "failed";

export type PlanAgentId =
  | "main"
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
export const PLAN_ARTIFACT_MARKER_RE =
  /<!--\s*atlarix-plan-artifact:([0-9a-f-]{36})\s*-->/gi;

export type PlanContentSegment =
  | { type: "markdown"; content: string }
  | { type: "plan-artifact"; planId: string };

/** Split raw assistant content into markdown and plan-artifact marker segments (order preserved). */
export function splitContentByPlanMarkers(
  content: string,
): PlanContentSegment[] {
  if (!content) return [];
  const re = new RegExp(PLAN_ARTIFACT_MARKER_RE.source, "gi");
  const segments: PlanContentSegment[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m.index > lastIndex) {
      const chunk = content.slice(lastIndex, m.index);
      if (chunk.trim()) segments.push({ type: "markdown", content: chunk });
    }
    segments.push({ type: "plan-artifact", planId: m[1] });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < content.length) {
    const tail = content.slice(lastIndex);
    if (tail.trim()) segments.push({ type: "markdown", content: tail });
  }
  return segments;
}
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
              status: ["pending", "in_progress", "done", "failed"].includes(
                String(t.status),
              )
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
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "task"
  );
}

/**
 * Markdown plans shaped as "## Phase 1: Title" / "**Phase 1:**" with bullet tasks underneath.
 */
function parseLoosePhasedPlan(content: string): PlanCardData | null {
  const lines = content.split(/\r?\n/);
  const groups: PlanTaskGroup[] = [];
  let current: {
    phaseNum: string;
    titleLine: string;
    tasks: PlanTask[];
  } | null = null;

  const flush = () => {
    if (!current || current.tasks.length === 0) return;
    const id = `phase-${current.phaseNum}`;
    groups.push({
      id,
      title: current.titleLine,
      tasks: current.tasks.map((t, j) => ({
        id: `${id}-task-${j + 1}-${toTaskId(t.label)}`,
        label: t.label,
        status: t.status,
      })),
    });
    current = null;
  };

  const headingMd =
    /^\s{0,3}#{1,6}\s*Phase\s+(\d+)\s*[:.\u2014\u2013-]?\s*(.*)$/i;
  const headingBold =
    /^\s*\*\*Phase\s+(\d+)\s*[:.\u2014\u2013-]?\s*(.+?)\*\*\s*$/i;

  for (const line of lines) {
    let m = line.match(headingMd);
    if (!m) m = line.match(headingBold);
    if (m) {
      flush();
      const rest = (m[2] || "").trim();
      const titleLine = rest ? `Phase ${m[1]}: ${rest}` : `Phase ${m[1]}`;
      current = { phaseNum: String(m[1]), titleLine, tasks: [] };
      continue;
    }
    if (!current) continue;
    const bullet = line.match(/^\s*[-*]\s+(.+)/);
    const numbered = line.match(/^\s*\d+\.\s+(.+)/);
    const raw = (bullet?.[1] ?? numbered?.[1] ?? "").trim();
    if (!raw) continue;
    current.tasks.push({
      id: "",
      label: raw,
      status: "pending",
    });
  }
  flush();

  if (groups.length === 0) return null;
  const totalTasks = groups.reduce((s, g) => s + g.tasks.length, 0);
  if (totalTasks < 2) return null;

  return { taskGroups: groups, completed: false };
}

function stripLoosePhasedPlanSection(content: string): string {
  if (!parseLoosePhasedPlan(content)) return content;
  const idx = content.search(/^\s*#{1,6}\s*Phase\s+\d+/im);
  if (idx < 0) {
    const idxBold = content.search(/\*\*Phase\s+\d+/i);
    if (idxBold < 0) return content;
    return content
      .slice(0, idxBold)
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd();
  }
  return content
    .slice(0, idx)
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
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
export function contentHasPlanArtifactMarker(content: string): boolean {
  if (!content) return false;
  return new RegExp(PLAN_ARTIFACT_MARKER_RE.source, "i").test(content);
}

export function extractPlanFromContent(content: string): PlanCardData | null {
  if (!content || typeof content !== "string") return null;
  if (contentHasPlanArtifactMarker(content)) return null;
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
  const report = parsePlanReport(content);
  if (report) return report;
  return parseLoosePhasedPlan(content);
}

/**
 * Remove plan payload / duplicate plan prose from the assistant message so the chat
 * body does not repeat markdown that is already shown in the Plan card.
 */
/** Remove marker and trailing plan prose when the full plan lives in a session artifact. */
export function stripPlanArtifactEchoFromDisplay(content: string): string {
  if (!contentHasPlanArtifactMarker(content)) return content;
  const re = new RegExp(PLAN_ARTIFACT_MARKER_RE.source, "gi");
  const match = re.exec(content);
  if (!match || match.index == null) return content.replace(re, "").trim();
  const before = content.slice(0, match.index).trim();
  const after = content.slice(match.index + match[0].length).trim();
  // Keep a short assistant note after the marker; drop duplicated long plan bodies only.
  if (
    after.length > 600 &&
    (after.includes("## ") || /\|\s*#?\s*Item\s*\|/i.test(after))
  ) {
    const firstBlock = after.split(/\n{2,}/)[0]?.trim() ?? "";
    const merged = [before, firstBlock].filter(Boolean).join("\n\n").trim();
    if (merged) return merged;
    // Entire answer may be the short intro after the marker only.
    return firstBlock || before || after;
  }
  const merged = [before, after].filter(Boolean).join("\n\n").trim();
  return merged || before || after;
}

export function stripAssistantPlanForDisplay(content: string): string {
  if (!content || typeof content !== "string") return "";
  let out = stripPlanArtifactEchoFromDisplay(content);
  out = out.replace(PLAN_ARTIFACT_MARKER_RE, "");
  out = out.replace(/<!--\s*atlarix-plan:\s*[\s\S]*?\s*-->/gi, "");
  out = out.replace(PLAN_BLOCK_RE, "");
  out = out.replace(JSON_PLAN_RE, "");
  out = out.replace(PLAN_REPORT_RE, "");
  out = stripLoosePhasedPlanSection(out);
  return out.replace(/\n{3,}/g, "\n\n").trim();
}
