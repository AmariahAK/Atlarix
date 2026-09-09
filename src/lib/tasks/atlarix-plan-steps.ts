/**
 * Parse numbered tasks from `.atlarix/ATLARIX_PLAN.md` for task ledger seeding.
 */

/**
 * Lines like `1. Do thing`, `2) Other`, or `3. [ ] Checkbox step` → step descriptions.
 * Completed lines `1. [x] Done` are skipped so the ledger only seeds active work.
 */
export function parsePlanToSteps(content: string): string[] {
  const steps: string[] = [];
  const reCheckbox = /^\s*(\d+)[.)]\s+\[( |x|~|!)\]\s*(.+)$/i;
  const rePlain = /^\s*(\d+)[.)]\s+(.+)$/;
  for (const line of content.split(/\r?\n/)) {
    const cb = line.match(reCheckbox);
    if (cb) {
      const mark = (cb[2] ?? "").trim().toLowerCase();
      const rest = cb[3]?.trim();
      if (!rest) continue;
      if (mark === "x") continue;
      steps.push(rest);
      continue;
    }
    const pl = line.match(rePlain);
    const rest = pl?.[2]?.trim();
    if (!rest) continue;
    if (/^\[( |x|~|!)\]\s/i.test(rest)) continue;
    if (/^#{1,6}\s/.test(rest)) continue;
    if (/^[-*+]\s+/.test(rest)) continue;
    steps.push(rest);
  }
  return steps;
}

// v10 live plan step progress helpers live in `plan-checklist.ts` (pure,
// renderer-safe). Re-exported here for main-side convenience.
export {
  parsePlanChecklist,
  setStepStateInPlanMarkdown,
  markAllChecklistStepsDone,
  type PlanStepState,
  type PlanChecklistStep,
  type SetStepStateResult,
} from "./plan-checklist";

/** Prefer first markdown `#` heading, else `**Task:**`, else first non-empty non-heading line. */
export function extractPlanTitle(content: string, fallback: string): string {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const h = line.match(/^\s*#\s+(.+?)\s*$/);
    if (h?.[1]) return h[1].trim().slice(0, 8000);
  }
  const taskLine = lines.find((l) => /^\*\*Task:\*\*/i.test(l));
  if (taskLine) {
    const t = taskLine.replace(/^\*\*Task:\*\*\s*/i, "").trim();
    if (t) return t.slice(0, 8000);
  }
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("```")) continue;
    return t.slice(0, 8000);
  }
  return fallback.slice(0, 8000);
}
