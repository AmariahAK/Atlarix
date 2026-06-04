/**
 * Plan checklist parsing + state rewriting (v10 live plan step progress).
 * Pure string functions — safe for both main and renderer. Works on any plan
 * markdown (session plan artifacts included).
 */

export type PlanStepState = "todo" | "in_progress" | "done" | "blocked";

export interface PlanChecklistStep {
  /** 1-based position within the checklist (not the markdown line number). */
  index: number;
  text: string;
  state: PlanStepState;
  /** 0-based line offset in the content. */
  line: number;
}

const MARK_BY_STATE: Record<PlanStepState, string> = {
  todo: " ",
  in_progress: "~",
  done: "x",
  blocked: "!",
};

const STATE_BY_MARK: Record<string, PlanStepState> = {
  " ": "todo",
  "": "todo",
  "~": "in_progress",
  x: "done",
  "!": "blocked",
};

const RE_NUMBERED_CHECKBOX = /^(\s*\d+[.)]\s+)\[( |x|~|!)?\]\s*(.+)$/i;
const RE_NUMBERED_PLAIN = /^(\s*\d+[.)]\s+)(.+)$/;
const RE_BULLET_CHECKBOX = /^(\s*[-*+]\s+)\[( |x|~|!)?\]\s*(.+)$/i;

/** Parse every checklist step (numbered w/ or w/o checkbox, bullet checkboxes) with its state. */
export function parsePlanChecklist(content: string): PlanChecklistStep[] {
  const steps: PlanChecklistStep[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const numbered = line.match(RE_NUMBERED_CHECKBOX);
    const bullet = numbered ? null : line.match(RE_BULLET_CHECKBOX);
    const m = numbered ?? bullet;
    if (m) {
      const text = m[3]?.trim();
      if (!text) continue;
      steps.push({
        index: steps.length + 1,
        text,
        state: STATE_BY_MARK[(m[2] ?? " ").toLowerCase()] ?? "todo",
        line: i,
      });
      continue;
    }
    const plain = line.match(RE_NUMBERED_PLAIN);
    const rest = plain?.[2]?.trim();
    if (!rest) continue;
    if (/^#{1,6}\s/.test(rest)) continue;
    steps.push({ index: steps.length + 1, text: rest, state: "todo", line: i });
  }
  return steps;
}

function rewriteStepLine(line: string, state: PlanStepState): string {
  const mark = MARK_BY_STATE[state];
  const numbered = line.match(RE_NUMBERED_CHECKBOX);
  if (numbered) return `${numbered[1]}[${mark}] ${numbered[3]}`;
  const bullet = line.match(RE_BULLET_CHECKBOX);
  if (bullet) return `${bullet[1]}[${mark}] ${bullet[3]}`;
  const plain = line.match(RE_NUMBERED_PLAIN);
  if (plain) return `${plain[1]}[${mark}] ${plain[2]}`;
  return line;
}

export interface SetStepStateResult {
  content: string;
  changed: boolean;
  step?: PlanChecklistStep;
}

/**
 * Flip one checklist step's checkbox in plan markdown. Target by 1-based
 * `stepIndex` or case-insensitive `stepText` substring. Plain numbered steps
 * gain a checkbox on first update. No-op (changed: false) when not found.
 */
export function setStepStateInPlanMarkdown(
  content: string,
  target: { stepIndex?: number; stepText?: string },
  state: PlanStepState,
): SetStepStateResult {
  const steps = parsePlanChecklist(content);
  let step: PlanChecklistStep | undefined;
  if (target.stepIndex != null) {
    step = steps.find((s) => s.index === target.stepIndex);
  }
  if (!step && target.stepText?.trim()) {
    const needle = target.stepText.trim().toLowerCase();
    step =
      steps.find((s) => s.text.toLowerCase() === needle) ??
      steps.find((s) => s.text.toLowerCase().includes(needle));
  }
  if (!step) return { content, changed: false };

  const lines = content.split(/\r?\n/);
  const before = lines[step.line]!;
  const after = rewriteStepLine(before, state);
  if (before === after) return { content, changed: false, step };
  lines[step.line] = after;
  return {
    content: lines.join("\n"),
    changed: true,
    step: { ...step, state },
  };
}

/** Safety net: when a plan flips to built, close out any remaining open steps. */
export function markAllChecklistStepsDone(content: string): {
  content: string;
  changed: boolean;
} {
  let out = content;
  let changed = false;
  for (const step of parsePlanChecklist(content)) {
    if (step.state === "done") continue;
    const res = setStepStateInPlanMarkdown(out, { stepIndex: step.index }, "done");
    if (res.changed) {
      out = res.content;
      changed = true;
    }
  }
  return { content: out, changed };
}
