/**
 * Plan checklist parsing + state rewriting (v10 live plan step progress).
 * Pure string functions — safe for both main and renderer. Works on any plan
 * markdown (session plan artifacts included).
 */

/**
 * `blocked` and `external` are both non-actionable, but they are NOT the same and
 * must not be merged. `blocked` = the model tried and is stuck (a red check, a bug
 * it can't find) — it does not license a success claim. `external` = the step is
 * the USER's by nature (rotate a key on a dashboard, sign a cert, verify on
 * hardware) — the model is right to hand it back and finish.
 *
 * Conflating them is what the completion gate used to do (`state !== "done"`), and
 * it forced the model to re-attempt work it could never complete.
 */
export type PlanStepState =
  | "todo"
  | "in_progress"
  | "done"
  | "blocked"
  | "external";

/**
 * States the model can still act on. The completion gate nudges on these and ONLY
 * these — see `plan-completion-gate.ts`.
 */
export function isActionableStepState(state: PlanStepState): boolean {
  return state === "todo" || state === "in_progress";
}

/**
 * Prefix for the reason carried by an `external` step.
 *
 * The reason has to live in the markdown to survive a reload (the ledger and the
 * plan card both re-parse the body; there is no column for it), so it is appended
 * to the step text. ONE constant so the append, the idempotency guard, and the
 * strip can never drift apart.
 */
export const EXTERNAL_REASON_PREFIX = "— needs you:";

const RE_EXTERNAL_REASON = /\s*—\s*needs you:\s*[^\n]*$/i;

/** Drop any trailing `— needs you: …` clause from a step's text. */
export function stripExternalReason(text: string): string {
  return text.replace(RE_EXTERNAL_REASON, "").trimEnd();
}

/** The reason on an `external` step, or undefined when it carries none. */
export function extractExternalReason(text: string): string | undefined {
  const m = RE_EXTERNAL_REASON.exec(text);
  if (!m) return undefined;
  const reason = m[0].replace(/\s*—\s*needs you:\s*/i, "").trim();
  return reason || undefined;
}

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
  // "@" reads as "assigned to someone else". A build older than this one parses
  // `[@]` via RE_NUMBERED_PLAIN instead, so the step shows as todo with a literal
  // "[@]" in its text — downgrade-only (plans are local SQLite), never a crash.
  external: "@",
};

const STATE_BY_MARK: Record<string, PlanStepState> = {
  " ": "todo",
  "": "todo",
  "~": "in_progress",
  x: "done",
  "!": "blocked",
  "@": "external",
};

const RE_NUMBERED_CHECKBOX = /^(\s*\d+[.)]\s+)\[( |x|~|!|@)?\]\s*(.+)$/i;
const RE_NUMBERED_PLAIN = /^(\s*\d+[.)]\s+)(.+)$/;
const RE_BULLET_CHECKBOX = /^(\s*[-*+]\s+)\[( |x|~|!|@)?\]\s*(.+)$/i;

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

/**
 * Rewrite one step's text for the target state.
 *
 * `external` carries its reason inline (see `EXTERNAL_REASON_PREFIX`). Always strip
 * first, then re-append: that makes re-marking IDEMPOTENT (no doubled suffix when a
 * model marks the same step twice, which it does) and makes moving off `external`
 * drop the clause rather than leaving a stale "needs you" on an active step.
 */
function rewriteStepText(
  text: string,
  state: PlanStepState,
  reason?: string,
): string {
  const base = stripExternalReason(text);
  if (state !== "external") return base;
  const trimmed = reason?.trim();
  if (!trimmed) return base;
  return `${base} ${EXTERNAL_REASON_PREFIX} ${trimmed}`;
}

function rewriteStepLine(
  line: string,
  state: PlanStepState,
  reason?: string,
): string {
  const mark = MARK_BY_STATE[state];
  const text = (t: string) => rewriteStepText(t, state, reason);
  const numbered = line.match(RE_NUMBERED_CHECKBOX);
  if (numbered) return `${numbered[1]}[${mark}] ${text(numbered[3]!)}`;
  const bullet = line.match(RE_BULLET_CHECKBOX);
  if (bullet) return `${bullet[1]}[${mark}] ${text(bullet[3]!)}`;
  const plain = line.match(RE_NUMBERED_PLAIN);
  if (plain) return `${plain[1]}[${mark}] ${text(plain[2]!)}`;
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
  /** `external` only — appended inline so it survives a reload. */
  reason?: string,
): SetStepStateResult {
  const steps = parsePlanChecklist(content);
  let step: PlanChecklistStep | undefined;
  const rawNeedle = target.stepText?.trim().toLowerCase() || undefined;
  // Candidate needles, most-faithful first: the text as sent, then the same text
  // with trailing junk stripped.
  //
  // Observed miss: a model sent step_text ending in a stray `}` — the step text
  // verbatim plus one character of malformed tool-arg spillover. `includes()` is
  // one-directional and unnormalised, so it matched nothing, the update silently
  // no-op'd, the completion gate then held the turn open on the unticked step,
  // and the model took the "rewrite the whole plan" escape the error offers —
  // losing the record of what had actually been done.
  //
  // Only TRAILING punctuation is stripped, and only as a second attempt. That is
  // deliberately narrower than falling back to `step_index` when the text
  // matches nothing: a model that names a step which genuinely is not in the
  // plan still gets not-found, because marking whatever sits at a stale index
  // would silently tick the WRONG step — worse than not-found, and the reason
  // the v14.8.10 rule below exists.
  const needles = rawNeedle
    ? [rawNeedle, rawNeedle.replace(/[\s"'`)\]}.,;:]+$/, "")].filter(
        (n, i, all) => n.length > 0 && all.indexOf(n) === i,
      )
    : [];
  const matches = (text: string): boolean =>
    needles.some((n) => text.includes(n));

  if (target.stepIndex != null) {
    step = steps.find((s) => s.index === target.stepIndex);
    // v14.8.10: when BOTH index and text are given and they disagree, the text
    // is the model's intent — the index is its (drifting) bookkeeping. Trusting
    // a mismatched index would silently mark the WRONG step (worse than
    // not-found); fall through to the text match instead.
    if (step && needles.length > 0 && !matches(step.text.toLowerCase())) {
      step = undefined;
    }
  }
  if (!step && needles.length > 0) {
    step =
      steps.find((s) => needles.includes(s.text.toLowerCase())) ??
      steps.find((s) => matches(s.text.toLowerCase()));
  }
  if (!step) return { content, changed: false };

  const lines = content.split(/\r?\n/);
  const before = lines[step.line]!;
  const after = rewriteStepLine(before, state, reason);
  if (before === after) return { content, changed: false, step };
  lines[step.line] = after;
  return {
    content: lines.join("\n"),
    changed: true,
    // Carry the REWRITTEN text: callers echo this back to the model, and the old
    // text would still show a stripped-off (or missing) "needs you" clause.
    step: { ...step, state, text: rewriteStepText(step.text, state, reason) },
  };
}

/**
 * v14.8.7 §A1: a COMPACT, high-salience ledger block re-injected near the latest
 * turn every turn (not the full plan body). Open-weight models lose the thread on
 * resume/network events and re-derive done-vs-pending by re-reading git; keeping
 * "what's left" as the freshest, most-authoritative thing they read fixes that.
 * Returns null when there are no steps (nothing to anchor).
 */
export function formatPlanChecklistForPrompt(
  steps: PlanChecklistStep[],
  title?: string,
): string | null {
  if (steps.length === 0) return null;
  const done = steps.filter((s) => s.state === "done").length;
  const inProgress = steps.find((s) => s.state === "in_progress");
  const blocked = steps.filter((s) => s.state === "blocked");
  const external = steps.filter((s) => s.state === "external");
  const pending = steps.filter((s) => s.state === "todo");

  const lines: string[] = [];
  const head = title?.trim() ? `${title.trim()} — ` : "";
  const externalNote = external.length ? ` · ${external.length} needs the user` : "";
  lines.push(
    `[Session plan] ${head}${done}/${steps.length} steps done${externalNote}.`,
  );
  if (inProgress) lines.push(`In progress: ${inProgress.index}. ${inProgress.text}`);
  if (pending.length) {
    lines.push(`Remaining: ${pending.map((s) => `${s.index}. ${s.text}`).join("; ")}`);
  }
  if (blocked.length) {
    lines.push(`Blocked: ${blocked.map((s) => `${s.index}. ${s.text}`).join("; ")}`);
  }
  if (external.length) {
    lines.push(
      `Needs the user (NOT yours to do — do not re-attempt): ${external
        .map((s) => `${s.index}. ${s.text}`)
        .join("; ")}`,
    );
  }
  // Fires when nothing ACTIONABLE is left, not when everything is `done`. The old
  // `done === steps.length` test meant a plan ending on a blocked/external step got
  // no permission-to-finish signal at all, so the model kept looking for work.
  if (!steps.some((s) => isActionableStepState(s.state))) {
    lines.push(
      external.length || blocked.length
        ? "No step is left for you — verify what you did, report what the user still needs to do, then finish."
        : "All steps are marked done — verify the work, then finish.",
    );
  }
  // C4: terse trailing steer (was a long sentence repeated every turn).
  lines.push(
    "Update it with plan(update_step) (step_text preferred) as you go; don't re-derive progress from git.",
  );
  return lines.join("\n");
}

/** Extract a plan title from the first markdown heading (for the ledger block). */
export function extractPlanChecklistTitle(content: string): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (m?.[1]) return m[1].replace(/[*_`]/g, "").trim();
  }
  return undefined;
}

/**
 * Safety net: when a plan flips to built, close out steps the model left OPEN.
 *
 * "Open" means actionable — `todo`/`in_progress`. It must NOT touch `blocked` or
 * `external`, because those are decisions the model already made: flipping them to
 * `done` deletes the reason, tells the user their step is finished when nobody did
 * it, and makes the card read 4/4. (This was already wrong for `blocked` before
 * `external` existed — the net silently converted "I'm stuck on this" into "done"
 * on any Build turn that wrote a file.)
 */
export function markAllChecklistStepsDone(content: string): {
  content: string;
  changed: boolean;
} {
  let out = content;
  let changed = false;
  for (const step of parsePlanChecklist(content)) {
    if (!isActionableStepState(step.state)) continue;
    const res = setStepStateInPlanMarkdown(out, { stepIndex: step.index }, "done");
    if (res.changed) {
      out = res.content;
      changed = true;
    }
  }
  return { content: out, changed };
}
