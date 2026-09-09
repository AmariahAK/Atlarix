const QUESTIONS_REGEX = /<questions>([\s\S]*?)<\/questions>/gi;
const QUESTIONS_LOOSE_OPEN = /<questions\s*>([\s\S]*?)(?:<\/questions>|$)/gi;
const FENCED_JSON_ARRAY = /```(?:json)?\s*(\[[\s\S]*?\])\s*```/gi;

/** Remove legacy `<questions>` XML blocks from stored/displayed assistant text. */
export function stripQuestionsBlockFromResponse(fullResponse: string): string {
  let text = fullResponse;
  text = text.replace(QUESTIONS_REGEX, "").trim();
  text = text.replace(QUESTIONS_LOOSE_OPEN, "").trim();
  text = text.replace(FENCED_JSON_ARRAY, "").trim();
  const qOpen = text.search(/<questions\b/i);
  if (qOpen !== -1) {
    const after = text.slice(qOpen);
    const arrStart = after.indexOf("[");
    if (arrStart !== -1) {
      let depth = 0;
      let inString = false;
      let esc = false;
      for (let j = arrStart; j < after.length; j++) {
        const c = after[j];
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
          if (depth === 0) {
            const endArr = qOpen + j + 1;
            text = (text.slice(0, qOpen) + text.slice(endArr))
              .replace(/\n{3,}/g, "\n\n")
              .trim();
            break;
          }
        }
      }
    } else {
      text = text.slice(0, qOpen).trim();
    }
  }
  return text;
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
  // Replace < characters inside atlarix-* tag attributes with fullwidth less-than sign ＜
  // This prevents parsing issues when attributes contain HTML tags like <a> or <div>
  let cleaned = text.replace(
    /<atlarix-[^<>]*(?:"[^"]*"[^<>]*)*>/g,
    (match: string) => {
      // Find all attribute values (within quotes) and replace < with ＜ and > with ＞
      const processedMatch = match.replace(
        /="([^"]*)"/g,
        (attrMatch: string, attrValue: string) => {
          const cleanedValue = attrValue
            .replace(/</g, "＜")
            .replace(/>/g, "＞");
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
const THINK_END_TAGS = [
  "</" + "redacted_thinking" + ">",
  "</" + "think" + ">",
] as const;

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
  if (halfLength > 50) {
    // Only check if content is significant
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
  if (halfLength > 100) {
    // Only check if content is significant
    const firstHalf = text.slice(0, halfLength);
    const secondHalf = text.slice(halfLength);

    if (firstHalf.trim() === secondHalf.trim()) {
      return firstHalf;
    }
  }
  return text;
}
