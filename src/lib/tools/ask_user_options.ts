/** Maximum preset choices shown in the ask_user UI (custom text is always available). */
export const ASK_USER_MAX_OPTIONS = 4;

/**
 * Normalize ask_user tool arguments so the UI always receives a proper `options`
 * list when the model intended multiple choice (arrays, string lists, inline
 * numbered lines in `question`, or comma lists after "Pick one:").
 */

/**
 * One answer the user can pick, as Claude Code's AskUserQuestion has it: a
 * short `label` (what the model receives when it is picked), an optional
 * `description` shown under it, and `recommended` for the one the model
 * suggests. "Other" is never an option: every surface has a free-text answer.
 */
export type AskUserOption = {
  label: string;
  description?: string;
  recommended?: boolean;
};

/** A question's `header` chip, at most this many characters (Claude Code's limit). */
export const ASK_USER_HEADER_MAX = 12;

/** "Postgres (Recommended)": the convention models carry over from Claude Code. */
const RECOMMENDED_SUFFIX_RE = /\s*[(\[]\s*recommended\s*[)\]]\s*$/i;

/**
 * Coerce one option item. Models vary wildly over OpenRouter: some emit plain
 * strings, others the Anthropic-native `{ label, description }` objects
 * (minimax). Without this, `String({…})` yields "[object Object]" and the
 * label-dedup below collapses them all to one.
 */
function coerceOption(x: unknown): AskUserOption | null {
  if (x == null) return null;
  let label: string;
  let description = "";
  let recommended = false;
  if (typeof x === "object") {
    const r = x as Record<string, unknown>;
    const v = r.label ?? r.value ?? r.title ?? r.name ?? r.text ?? r.option;
    label = v == null ? "" : String(v).trim();
    const d = r.description ?? r.detail ?? r.hint;
    description = typeof d === "string" ? d.trim() : "";
    recommended = r.recommended === true || r.recommended === "true";
  } else {
    label = String(x).trim();
  }
  if (RECOMMENDED_SUFFIX_RE.test(label)) {
    label = label.replace(RECOMMENDED_SUFFIX_RE, "").trim();
    recommended = true;
  }
  if (!label) return null;
  return {
    label,
    ...(description ? { description } : {}),
    ...(recommended ? { recommended: true } : {}),
  };
}

/** First option per label wins. */
function dedupeOptions(options: AskUserOption[]): AskUserOption[] | undefined {
  const seen = new Set<string>();
  const out = options.filter((o) => !seen.has(o.label) && !!seen.add(o.label));
  return out.length > 0 ? out : undefined;
}

function coerceOptions(raw: unknown): AskUserOption[] | undefined {
  if (raw == null) return undefined;
  if (Array.isArray(raw)) {
    return dedupeOptions(raw.map(coerceOption).filter((o): o is AskUserOption => o !== null));
  }
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return undefined;
    const asOptions = (parts: string[]) => coerceOptions(parts);
    const byNl = t
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
      .filter(Boolean);
    if (byNl.length > 1) return asOptions(byNl);
    const byPipe = t
      .split(/\s*\|\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (byPipe.length > 1) return asOptions(byPipe);
    const bySemi = t
      .split(/\s*;\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (bySemi.length > 1) return asOptions(bySemi);
    try {
      const j = JSON.parse(t) as unknown;
      return coerceOptions(j);
    } catch {
      /* not JSON */
    }
  }
  return undefined;
}

/** The text of an option in any shape a renderer may be handed (an older build sends strings). */
export function askUserOptionLabel(option: unknown): string {
  return coerceOption(option)?.label ?? "";
}

function extractChoiceLinesFromQuestion(
  question: string,
): { headline: string; options: string[] } | null {
  const lines = question
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return null;

  const head = lines[0]!;
  const rest = lines.slice(1);

  const bulletOrNumber = rest
    .map((line) => {
      const m = line.match(/^(?:[-*•]|\d+[.)])\s*(.+)$/);
      return m?.[1]?.trim() ?? "";
    })
    .filter((s) => s.length > 0);

  if (bulletOrNumber.length >= 2) {
    return { headline: head, options: bulletOrNumber };
  }

  const mcCue =
    /\b(pick one|choose one|select one|which (?:option|one))\b/i.test(head);
  if (
    mcCue &&
    rest.length >= 2 &&
    rest.every((l) => l.length > 0 && l.length <= 220)
  ) {
    return { headline: head, options: rest };
  }

  return null;
}

/** e.g. "What … today? Pick one: A, B, C" on one line (uses last `:` before list). */
function extractCommaChoicesAfterCue(
  question: string,
): { headline: string; options: string[] } | null {
  if (
    !/\b(pick one|choose one|select one|which (?:option|one))\b/i.test(question)
  ) {
    return null;
  }
  const lastColon = question.lastIndexOf(":");
  if (lastColon === -1) return null;
  const after = question.slice(lastColon + 1).trim();
  if (!after || /[\r\n]/.test(after)) return null;
  const opts = after
    .split(/,\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (opts.length < 2) return null;
  const headline = question.slice(0, lastColon).trim();
  return { headline: headline || question.trim(), options: opts };
}

function capAskUserOptions(options: AskUserOption[]): AskUserOption[] {
  return options.slice(0, ASK_USER_MAX_OPTIONS);
}

export type AskUserQuestion = {
  question: string;
  /** A short chip naming the topic ("Auth method"), at most ASK_USER_HEADER_MAX chars. */
  header?: string;
  /** The user may pick several options; their answer is the labels joined with ", ". */
  multiSelect?: boolean;
  options?: AskUserOption[];
};

/** Hard cap on questions per ask_user call. */
export const ASK_USER_MAX_QUESTIONS = 5;

/**
 * v10.1: normalize ask_user args into one or more questions. Supports the
 * multi-question form (`questions: [{question, options?}, …]`) alongside the
 * legacy single `question` + `options`. Streaming pauses until the user
 * answers ALL of them.
 */
export function normalizeAskUserQuestions(
  args: Record<string, unknown>,
): AskUserQuestion[] {
  const rawQuestions = args.questions;
  if (Array.isArray(rawQuestions) && rawQuestions.length > 0) {
    const out: AskUserQuestion[] = [];
    for (const item of rawQuestions) {
      if (typeof item === "string") {
        const norm = normalizeAskUserPayload({ question: item });
        if (norm.question.trim()) out.push(norm);
        continue;
      }
      if (item && typeof item === "object") {
        const rec = item as Record<string, unknown>;
        const norm = normalizeAskUserPayload({
          question:
            rec.question ??
            rec.text ??
            rec.prompt ??
            rec.header ??
            rec.title ??
            rec.label ??
            "",
          options: rec.options ?? rec.choices ?? rec.answers,
        });
        if (norm.question.trim()) out.push(withExtras(norm, rec));
      }
    }
    if (out.length > 0) return out.slice(0, ASK_USER_MAX_QUESTIONS);
  }
  const single = normalizeAskUserPayload(args);
  return single.question.trim() ? [withExtras(single, args)] : [];
}

/**
 * `header` and `multiSelect`, in that key order after the question. A header
 * that IS the question (the model sent only `header`) is not repeated as a
 * chip; multiSelect means nothing without options to pick.
 */
function withExtras(
  norm: { question: string; options?: AskUserOption[] },
  rec: Record<string, unknown>,
): AskUserQuestion {
  const rawHeader = typeof rec.header === "string" ? rec.header.trim() : "";
  const header =
    rawHeader && rawHeader !== norm.question.trim() ? rawHeader.slice(0, ASK_USER_HEADER_MAX).trim() : "";
  const multi = rec.multiSelect ?? rec.multi_select ?? rec.multiple;
  const multiSelect = (multi === true || multi === "true") && (norm.options?.length ?? 0) > 0;
  return {
    question: norm.question,
    ...(header ? { header } : {}),
    ...(multiSelect ? { multiSelect: true } : {}),
    ...(norm.options ? { options: norm.options } : {}),
  };
}

// ─── Answers ────────────────────────────────────────────────────────────────

/** What a skipped question sends (every surface). */
export const ASK_USER_SKIP_ANSWER = "(skipped)";

/**
 * The one message the model receives: the answer itself for one question,
 * `Q: … A: …` pairs for several, with blanks sent as "(skipped)". Desktop,
 * CLI and the browser extension all send this, byte for byte.
 */
export function combineAskUserAnswers(questions: ReadonlyArray<{ question: string }>, answers: readonly string[]): string {
  if (questions.length === 1) return answers[0]?.trim() ?? "";
  return questions.map((q, i) => `Q: ${q.question}\nA: ${answers[i]?.trim() || ASK_USER_SKIP_ANSWER}`).join("\n\n");
}

/** A multi-select answer: the picked labels joined with ", ", then the typed "Other" text. */
export function joinAskUserPicks(labels: readonly string[], other = ""): string {
  return [...labels, other.trim()].filter(Boolean).join(", ");
}

// ─── Wire shape ─────────────────────────────────────────────────────────────

/**
 * A question as it is stored (the `atlarix-questions` marker) and sent to
 * editors (ACP `_meta.atlarix.question`). `options` stays the label strings an
 * older desktop, CLI or VS Code build reads (an object there drew
 * "[object Object]"); `choices` carries the full options for current readers.
 */
export type AskUserWireQuestion = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: string[];
  choices?: AskUserOption[];
};

export function toAskUserWire(questions: readonly AskUserQuestion[]): AskUserWireQuestion[] {
  return questions.map((q) => ({
    question: q.question,
    ...(q.header ? { header: q.header } : {}),
    ...(q.multiSelect ? { multiSelect: true } : {}),
    ...(q.options?.length ? { options: q.options.map((o) => o.label), choices: q.options } : {}),
  }));
}

/** Questions from the wire (either shape, any build): `choices` when present, else `options`. */
export function readAskUserQuestions(raw: unknown): AskUserQuestion[] {
  if (!Array.isArray(raw)) return [];
  const items = raw.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  if (items.length === 0) return [];
  return normalizeAskUserQuestions({
    questions: items.map((q) => ({ ...q, options: Array.isArray(q.choices) ? q.choices : q.options, choices: undefined })),
  });
}

export function normalizeAskUserPayload(args: Record<string, unknown>): {
  question: string;
  options?: AskUserOption[];
} {
  const rawQuestion = String(
    args.question ??
      args.prompt ??
      args.text ??
      args.header ??
      args.title ??
      "",
  );
  const fromParams =
    coerceOptions(args.options) ??
    coerceOptions(args.choices) ??
    coerceOptions(args.answers);
  if (fromParams && fromParams.length > 0) {
    // Never let options leak into the question slot: if the model gave choices
    // but no readable question text, synthesize a generic prompt so the entry
    // still renders (and is never dropped by the empty-question filter).
    return {
      question: rawQuestion.trim() || "Select an option:",
      options: capAskUserOptions(fromParams),
    };
  }

  const multiline = extractChoiceLinesFromQuestion(rawQuestion);
  const inline = multiline && multiline.options.length >= 2 ? multiline : extractCommaChoicesAfterCue(rawQuestion);
  const inlineOptions = inline && inline.options.length >= 2 ? coerceOptions(inline.options) : undefined;
  if (inline && inlineOptions && inlineOptions.length >= 2) {
    return {
      question: inline.headline,
      options: capAskUserOptions(inlineOptions),
    };
  }

  return { question: rawQuestion, options: undefined };
}
