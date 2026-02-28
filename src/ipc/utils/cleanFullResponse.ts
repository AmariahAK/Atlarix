const SUGGESTIONS_REGEX = /<suggestions>([\s\S]*?)<\/suggestions>/i;

/**
 * Extract and remove the <suggestions>...</suggestions> block from the response.
 * Returns cleaned response (for DB/display) and up to 3 suggestion strings for UI chips.
 */
export function extractSuggestions(fullResponse: string): {
  cleaned: string;
  suggestions: string[];
} {
  const match = fullResponse.match(SUGGESTIONS_REGEX);
  if (!match) {
    return { cleaned: fullResponse, suggestions: [] };
  }
  const raw = match[1].trim();
  let suggestions: string[] = [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      suggestions = parsed
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 3);
    }
  } catch {
    // Plain list: split by newline or comma
    suggestions = raw
      .split(/[\n,]/)
      .map((s) => s.replace(/^["'\s-•*]+|["'\s-•*]+$/g, "").trim())
      .filter(Boolean)
      .slice(0, 3);
  }
  const cleaned = fullResponse.replace(SUGGESTIONS_REGEX, "").trim();
  return { cleaned, suggestions };
}

export function cleanFullResponse(text: string): string {
  // Replace < characters inside dyad-* attributes with fullwidth less-than sign ＜
  // This prevents parsing issues when attributes contain HTML tags like <a> or <div>
  let cleaned = text.replace(/<dyad-[^<>]*(?:"[^"]*"[^<>]*)*>/g, (match: string) => {
    // Find all attribute values (content within quotes) and replace < with ＜ and > with ＞
    const processedMatch = match.replace(
      /="([^"]*)"/g,
      (attrMatch: string, attrValue: string) => {
        const cleanedValue = attrValue.replace(/</g, "＜").replace(/>/g, "＞");
        return `="${cleanedValue}"`;
      },
    );
    return processedMatch;
  });

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
function deduplicateContent(text: string): string {
  // Find thinking block if present
  const thinkEndMatch = text.match(/<\/think>/);

  if (!thinkEndMatch) {
    // No thinking block - check for simple exact duplication
    return deduplicateSimpleContent(text);
  }

  // Extract content after </think>
  const thinkEndIndex = (thinkEndMatch.index ?? 0) + thinkEndMatch[0].length;
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
