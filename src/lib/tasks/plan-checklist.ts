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

/**
 * The indented plain lines a step wraps onto ("1. [x] Implement `toggle`… return
 * the\n   updated `Todo`."), joined to its text: cut at the first line, a card
 * showed "…return the" (QA). Sub-bullets and numbered lines stay their own.
 */
function continuation(lines: readonly string[], from: number): string {
  const parts: string[] = [];
  for (let j = from; j < lines.length; j++) {
    const l = lines[j]!;
    if (!/^\s{2,}\S/.test(l)) break;
    if (/^\s*(?:[-*+]|\d+[.)])\s/.test(l)) break;
    parts.push(l.trim());
  }
  return parts.join(" ");
}

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
      const first = m[3]?.trim();
      if (!first) continue;
      const more = continuation(lines, i + 1);
      const text = more ? `${first} ${more}` : first;
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
    const more = continuation(lines, i + 1);
    steps.push({ index: steps.length + 1, text: more ? `${rest} ${more}` : rest, state: "todo", line: i });
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
  // Second pass, only after every faithful attempt has missed: compare with
  // markdown formatting removed and whitespace collapsed.
  //
  // Observed miss (live, 2026-08-19): the plan stored
  //   `**1. Append 15 quotes to \`upcoming-quotes.json\`** — insert before …`
  // and the model sent
  //   `Append 15 quotes to upcoming-quotes.json`
  // Same words, no backticks. `includes()` is byte-exact, so it matched nothing,
  // the model was told "rewrite the whole plan with operation:'write'", it did —
  // re-marking finished steps as in_progress — and the plan never closed. The
  // needle is formatting the model cannot be expected to reproduce: it is writing
  // prose about a step, not quoting markdown.
  //
  // Safe to widen only this far: it removes formatting characters and collapses
  // whitespace runs. No word is added, removed or reordered, so it cannot turn
  // step 1's text into step 2's. Anything stronger (fuzzy distance, word-subset)
  // could, and would risk ticking the WRONG step — the failure the v14.8.10 rule
  // below exists to prevent.
  const normalizeForMatch = (text: string): string =>
    text
      .replace(/[`*_~]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const normalizedNeedles = needles
    .map(normalizeForMatch)
    .filter((n) => n.length > 0);
  const matches = (text: string): boolean => {
    if (needles.some((n) => text.includes(n))) return true;
    const normalizedText = normalizeForMatch(text);
    return normalizedNeedles.some((n) => normalizedText.includes(n));
  };

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
  // EVERY in-progress step, not just the first.
  //
  // This used to be `.find()`, and `pending` covers only `todo` — so a model that
  // started several steps saw the extras NOWHERE: not done, not "In progress"
  // (one line only), not "Remaining". With all six in progress the block read
  // "0/6 steps done" plus a single in-progress line, which is indistinguishable
  // from a wiped plan. Observed live: the model concluded "the plan ledger has
  // been reset again", re-emitted the plan via plan(write) — which re-marked them
  // in_progress rather than done — and looped, while the completion gate
  // separately listed all three as unaccounted for. The two signals contradicted
  // each other because only one of them could count.
  const inProgress = steps.filter((s) => s.state === "in_progress");
  const blocked = steps.filter((s) => s.state === "blocked");
  const external = steps.filter((s) => s.state === "external");
  const pending = steps.filter((s) => s.state === "todo");

  const lines: string[] = [];
  const head = title?.trim() ? `${title.trim()} — ` : "";
  // Spell out in-progress in the header too, so "0/N done" is never bare: a
  // count of zero with no explanation is what read as "the plan was reset".
  const progressNote = inProgress.length
    ? ` · ${inProgress.length} in progress`
    : "";
  const externalNote = external.length
    ? ` · ${external.length} needs the user`
    : "";
  lines.push(
    `[Session plan] ${head}${done}/${steps.length} steps done${progressNote}${externalNote}.`,
  );
  if (inProgress.length) {
    lines.push(
      `In progress (mark each done when it is finished): ${inProgress
        .map((s) => `${s.index}. ${s.text}`)
        .join("; ")}`,
    );
  }
  if (pending.length) {
    lines.push(
      `Remaining: ${pending.map((s) => `${s.index}. ${s.text}`).join("; ")}`,
    );
  }
  if (blocked.length) {
    lines.push(
      `Blocked: ${blocked.map((s) => `${s.index}. ${s.text}`).join("; ")}`,
    );
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
    const res = setStepStateInPlanMarkdown(
      out,
      { stepIndex: step.index },
      "done",
    );
    if (res.changed) {
      out = res.content;
      changed = true;
    }
  }
  return { content: out, changed };
}
