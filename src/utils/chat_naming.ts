/**
 * Chat naming helpers shared with older call sites.
 *
 * Session titling itself lives in `src/lib/session-title/` since v14.52.0:
 * `title-text.ts` (prompt, sanitising, reply rejection, placeholder),
 * `generate-title.ts` (model chain and call) and `title-quality.ts`. This file
 * keeps the one piece that is about MESSAGE CONTENT rather than titles.
 */

import { extractVisibleAnswerMarkdown } from "../lib/chat/answer-display";

export {
  isLowQualityGeneratedTitle,
  looksLikeToolOrStructuredDebrisTitle,
} from "../lib/session-title/title-quality";

/** Strip thinking/tool XML so title models see user-visible prose only. */
export function stripContentForTitleSource(
  content: string,
  role: "user" | "assistant" | "tool" | string,
): string {
  const raw = (content || "").trim();
  if (!raw) return "";
  if (role === "assistant" || role === "tool") {
    const visible = extractVisibleAnswerMarkdown(raw);
    if (visible.trim().length >= 8) return visible.trim();
  }
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
