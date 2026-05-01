import type { Question } from "../ipc_types";

const QUESTIONS_REGEX = /<questions>([\s\S]*?)<\/questions>/i;
const QUESTIONS_LOOSE_OPEN = /<questions\s*>([\s\S]*?)(?:<\/questions>|$)/i;
const FENCED_JSON_ARRAY = /```(?:json)?\s*(\[[\s\S]*?\])\s*```/i;

function normalizeQuestionItem(raw: unknown): Question | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : null;
  const question = typeof o.question === "string" ? o.question : null;
  if (!id || !question) return null;
  const choices = Array.isArray(o.choices)
    ? (o.choices as unknown[]).map((c) => String(c)).filter(Boolean)
    : [];
  const allowCustom =
    typeof o.allowCustom === "boolean"
      ? o.allowCustom
      : String(o.allowCustom ?? "false").toLowerCase() === "true";
  return { id, question, choices, allowCustom };
}

function parseQuestionsPayloadFromUnknown(parsed: unknown): {
  questions: Question[];
  title?: string;
} | null {
  if (Array.isArray(parsed)) {
    const questions: Question[] = [];
    for (const item of parsed) {
      const q = normalizeQuestionItem(item);
      if (q) questions.push(q);
    }
    return questions.length > 0 ? { questions } : null;
  }
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    const titleRaw = o.title ?? o.prompt;
    const title =
      typeof titleRaw === "string" && titleRaw.trim()
        ? titleRaw.trim()
        : undefined;
    const arr = o.questions;
    if (!Array.isArray(arr)) return null;
    const questions: Question[] = [];
    for (const item of arr) {
      const q = normalizeQuestionItem(item);
      if (q) questions.push(q);
    }
    if (questions.length === 0) return null;
    return title ? { questions, title } : { questions };
  }
  return null;
}

function parseQuestionsPayloadFromJsonText(raw: string): {
  questions: Question[] | null;
  title?: string;
} {
  const trimmed = raw.trim();
  if (!trimmed) return { questions: null };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const payload = parseQuestionsPayloadFromUnknown(parsed);
    if (!payload) return { questions: null };
    return { questions: payload.questions, ...(payload.title ? { title: payload.title } : {}) };
  } catch {
    return { questions: null };
  }
}

/** Find first top-level JSON array starting at `[` with bracket depth (strings ignored roughly). */
function extractBalancedJsonArray(s: string, fromIndex: number): string | null {
  const i = s.indexOf("[", fromIndex);
  if (i === -1) return null;
  let depth = 0;
  let inString = false;
  let esc = false;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (inString) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c === "\\") {
        esc = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return s.slice(i, j + 1);
    }
  }
  return null;
}

/**
 * Parse and remove the <questions>...</questions> block from the response.
 * Returns cleaned content and parsed questions, or null if malformed/missing.
 */
export function parseQuestions(fullResponse: string): {
  cleanContent: string;
  questions: Question[] | null;
  title?: string | null;
} {
  let match = fullResponse.match(QUESTIONS_REGEX);
  if (match) {
    const raw = match[1].trim();
    const { questions, title } = parseQuestionsPayloadFromJsonText(raw);
    const cleanContent = fullResponse.replace(QUESTIONS_REGEX, "").trim();
    return {
      cleanContent,
      questions,
      ...(title ? { title } : {}),
    };
  }

  match = fullResponse.match(QUESTIONS_LOOSE_OPEN);
  if (match) {
    const raw = match[1].trim();
    let payload = parseQuestionsPayloadFromJsonText(raw);
    if (!payload.questions) {
      const arr = extractBalancedJsonArray(match[1], 0);
      if (arr) payload = parseQuestionsPayloadFromJsonText(arr);
    }
    const cleanContent = fullResponse.replace(QUESTIONS_LOOSE_OPEN, "").trim();
    if (payload.questions?.length) {
      return {
        cleanContent,
        questions: payload.questions,
        ...(payload.title ? { title: payload.title } : {}),
      };
    }
    return { cleanContent, questions: null };
  }

  const fence = fullResponse.match(FENCED_JSON_ARRAY);
  if (fence?.[1]) {
    const payload = parseQuestionsPayloadFromJsonText(fence[1]);
    if (payload.questions?.length) {
      const cleanContent = fullResponse.replace(FENCED_JSON_ARRAY, "").trim();
      return {
        cleanContent,
        questions: payload.questions,
        ...(payload.title ? { title: payload.title } : {}),
      };
    }
  }

  const qOpen = fullResponse.search(/<questions\b/i);
  if (qOpen !== -1) {
    const after = fullResponse.slice(qOpen);
    const arr = extractBalancedJsonArray(after, 0);
    if (arr) {
      const payload = parseQuestionsPayloadFromJsonText(arr);
      if (payload.questions?.length) {
        const endArr = qOpen + after.indexOf(arr) + arr.length;
        const cleanContent = (fullResponse.slice(0, qOpen) + fullResponse.slice(endArr)).replace(/\n{3,}/g, "\n\n").trim();
        return {
          cleanContent,
          questions: payload.questions,
          ...(payload.title ? { title: payload.title } : {}),
        };
      }
    }
  }

  return { cleanContent: fullResponse, questions: null };
}

/** While streaming: hide prose after an unclosed `<questions>` block so raw JSON does not flash in the bubble. */
export function stripPartialQuestionsBlockForDisplay(text: string): string {
  const open = text.search(/<questions\b/i);
  if (open === -1) return text;
  const rest = text.slice(open);
  if (/<\/questions>/i.test(rest)) return text;
  return text.slice(0, open).trimEnd();
}

export function cleanFullResponse(text: string): string {
  // Replace < characters inside dyad-* / atlarix-* tag attributes with fullwidth less-than sign ＜
  // This prevents parsing issues when attributes contain HTML tags like <a> or <div>
  let cleaned = text.replace(
    /<(?:dyad|atlarix)-[^<>]*(?:"[^"]*"[^<>]*)*>/g,
    (match: string) => {
    // Find all attribute values (within quotes) and replace < with ＜ and > with ＞
    const processedMatch = match.replace(
      /="([^"]*)"/g,
      (attrMatch: string, attrValue: string) => {
        const cleanedValue = attrValue.replace(/</g, "＜").replace(/>/g, "＞");
        return `="${cleanedValue}"`;
      },
    );
    return processedMatch;
    },
  );

  // Deduplicate content for reasoning models (MiniMax, etc.)
  // Some models output: <think>reasoning</think>content + content (full duplication)
  // We detect and remove the exact duplicated suffix
  cleaned = deduplicateContent(cleaned);

  return cleaned;
}

/**
 * Detect and remove duplicate content that some reasoning models output.
 * MiniMax 2.1 and similar models sometimes repeat the entire response after the thinking block.
 *
 * Example (before): "<think>thoughts</think>Hey! How are you?Hey! How are you?"
 * Example (after):  "<think>thoughts</think>Hey! How are you?"
 */
const THINK_END_TAGS = ["</think>", "</think>"] as const;

function findFirstThinkEnd(text: string): {
  index: number;
  length: number;
} | null {
  let best: { index: number; length: number } | null = null;
  for (const tag of THINK_END_TAGS) {
    const i = text.indexOf(tag);
    if (i === -1) continue;
    if (!best || i < best.index) {
      best = { index: i, length: tag.length };
    }
  }
  return best;
}

function deduplicateContent(text: string): string {
  const thinkEnd = findFirstThinkEnd(text);

  if (!thinkEnd) {
    // No thinking block - check for simple exact duplication
    return deduplicateSimpleContent(text);
  }

  const thinkEndIndex = thinkEnd.index + thinkEnd.length;
  const contentAfterThink = text.slice(thinkEndIndex);

  // Check if this content is exactly duplicated
  const halfLength = Math.floor(contentAfterThink.length / 2);
  if (halfLength > 50) { // Only check if content is significant
    const firstHalf = contentAfterThink.slice(0, halfLength);
    const secondHalf = contentAfterThink.slice(halfLength);

    // Check if content is duplicated (with tolerance for whitespace differences)
    if (firstHalf.trim() === secondHalf.trim()) {
      // Remove the duplicate second half
      return text.slice(0, thinkEndIndex) + firstHalf;
    }
  }

  return text;
}

/**
 * Check for simple content duplication without thinking blocks
 */
function deduplicateSimpleContent(text: string): string {
  const halfLength = Math.floor(text.length / 2);
  if (halfLength > 100) { // Only check if content is significant
    const firstHalf = text.slice(0, halfLength);
    const secondHalf = text.slice(halfLength);

    if (firstHalf.trim() === secondHalf.trim()) {
      return firstHalf;
    }
  }
  return text;
}
