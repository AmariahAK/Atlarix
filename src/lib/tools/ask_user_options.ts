/** Maximum preset choices shown in the ask_user UI (custom text is always available). */
export const ASK_USER_MAX_OPTIONS = 4;

/**
 * Normalize ask_user tool arguments so the UI always receives a proper `options`
 * list when the model intended multiple choice (arrays, string lists, inline
 * numbered lines in `question`, or comma lists after "Pick one:").
 */

function coerceStringArray(raw: unknown): string[] | undefined {
  if (raw == null) return undefined;
  if (Array.isArray(raw)) {
    const out = raw.map((x) => String(x).trim()).filter(Boolean);
    return out.length > 0 ? [...new Set(out)] : undefined;
  }
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return undefined;
    const byNl = t
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
      .filter(Boolean);
    if (byNl.length > 1) return [...new Set(byNl)];
    const byPipe = t.split(/\s*\|\s*/).map((s) => s.trim()).filter(Boolean);
    if (byPipe.length > 1) return [...new Set(byPipe)];
    const bySemi = t.split(/\s*;\s*/).map((s) => s.trim()).filter(Boolean);
    if (bySemi.length > 1) return [...new Set(bySemi)];
    try {
      const j = JSON.parse(t) as unknown;
      return coerceStringArray(j);
    } catch {
      /* not JSON */
    }
  }
  return undefined;
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

  const mcCue = /\b(pick one|choose one|select one|which (?:option|one))\b/i.test(head);
  if (mcCue && rest.length >= 2 && rest.every((l) => l.length > 0 && l.length <= 220)) {
    return { headline: head, options: rest };
  }

  return null;
}

/** e.g. "What … today? Pick one: A, B, C" on one line (uses last `:` before list). */
function extractCommaChoicesAfterCue(question: string): { headline: string; options: string[] } | null {
  if (!/\b(pick one|choose one|select one|which (?:option|one))\b/i.test(question)) {
    return null;
  }
  const lastColon = question.lastIndexOf(":");
  if (lastColon === -1) return null;
  const after = question.slice(lastColon + 1).trim();
  if (!after || /[\r\n]/.test(after)) return null;
  const opts = after.split(/,\s+/).map((s) => s.trim()).filter(Boolean);
  if (opts.length < 2) return null;
  const headline = question.slice(0, lastColon).trim();
  return { headline: headline || question.trim(), options: opts };
}

function capAskUserOptions(options: string[]): string[] {
  return options.slice(0, ASK_USER_MAX_OPTIONS);
}

export function normalizeAskUserPayload(args: Record<string, unknown>): {
  question: string;
  options?: string[];
} {
  const rawQuestion = String(args.question ?? "");
  const fromParams =
    coerceStringArray(args.options) ?? coerceStringArray(args.choices);
  if (fromParams && fromParams.length > 0) {
    return { question: rawQuestion, options: capAskUserOptions(fromParams) };
  }

  const multiline = extractChoiceLinesFromQuestion(rawQuestion);
  if (multiline && multiline.options.length >= 2) {
    return {
      question: multiline.headline,
      options: capAskUserOptions(multiline.options),
    };
  }

  const comma = extractCommaChoicesAfterCue(rawQuestion);
  if (comma && comma.options.length >= 2) {
    return {
      question: comma.headline,
      options: capAskUserOptions(comma.options),
    };
  }

  return { question: rawQuestion, options: undefined };
}
