import { describe, expect, it } from "vitest";
import { sanitizeMarkdownForDisplay } from "@/lib/chat/answer-display";
import { finalAnswerText } from "@/lib/chat/assistant-message-parts";

/**
 * QA (owner, 2026-10-31): code read back through a session tool had its
 * backtick strings (template literals, inline code) replaced by 0, 1, 2…
 * A code span that sits inside a `{…}` JSON object was held twice, and the
 * single-pass restore left the inner placeholder as a bare digit.
 */
describe("template literals and inline code round-trip", () => {
  it("sanitizeMarkdownForDisplay keeps them byte-for-byte", () => {
    const src = [
      "encodeURIComponent(`/slack/link${location.search}`)",
      "to={`/login?next=${next}`}",
      "`${trimmed}/v1`",
      "new Error(`something ${x}`)",
    ].join("\n");
    expect(sanitizeMarkdownForDisplay(src)).toBe(src);
  });

  it("finalAnswerText keeps them byte-for-byte", () => {
    const src =
      "Here is the line:\n\n`encodeURIComponent(`/slack/link${location.search}`)` and `to={`/login?next=${next}`}`";
    expect(finalAnswerText(src)).toContain(
      "`encodeURIComponent(`/slack/link${location.search}`)`",
    );
    expect(finalAnswerText(src)).toContain("`to={`/login?next=${next}`}`");
  });
});
