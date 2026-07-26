/**
 * Regression cover for the four-way think-tag normalization bug.
 *
 * Four call sites each rewrote the OPENER to `redacted_thinking` but the CLOSER to
 * `</think>`, so the pair never matched. Each consumer then failed differently —
 * deleted the message tail, rendered a bare `</think>`, or swallowed the answer
 * into the Thoughts card. These tests pin the behaviour of the shared normalizer
 * AND of each consumer, so the four copies can't drift back apart.
 *
 * Tag literals are concatenated (`"<" + "think" + ">"`) so a future grep-and-strip
 * over test sources can't silently rewrite the very strings under test — the same
 * convention `thinking_tags.test.ts` already uses.
 */
import { describe, expect, it } from "vitest";
import { normalizeThinkingTags } from "@/lib/thinking/normalize-thinking-tags";
import { extractVisibleAnswerMarkdown } from "@/lib/chat/answer-display";
import { extractThinkingFromContent } from "@/lib/thinking/extract-thinking-from-content";
import { parseAssistantMessageParts } from "@/lib/chat/assistant-message-parts";

const T_OPEN = "<" + "think" + ">";
const T_CLOSE = "</" + "think" + ">";
const ING_OPEN = "<" + "thinking" + ">";
const ING_CLOSE = "</" + "thinking" + ">";
const CANON_OPEN = "<" + "redacted_thinking" + ">";
const CANON_CLOSE = "</" + "redacted_thinking" + ">";

describe("normalizeThinkingTags", () => {
  it("canonicalizes both variants to a MATCHING pair", () => {
    expect(normalizeThinkingTags(`${T_OPEN}a${T_CLOSE}`)).toBe(
      `${CANON_OPEN}a${CANON_CLOSE}`,
    );
    expect(normalizeThinkingTags(`${ING_OPEN}a${ING_CLOSE}`)).toBe(
      `${CANON_OPEN}a${CANON_CLOSE}`,
    );
  });

  it("preserves opener attributes (the parser reads them)", () => {
    const out = normalizeThinkingTags(`<thinking signature="abc">a${ING_CLOSE}`);
    expect(out).toContain('<redacted_thinking signature="abc">');
  });

  it("is case-insensitive", () => {
    expect(normalizeThinkingTags("<Think>a</THINK>")).toBe(
      `${CANON_OPEN}a${CANON_CLOSE}`,
    );
  });

  it("drops a closer that has no opener", () => {
    expect(normalizeThinkingTags(`Intro${T_CLOSE}Tail`)).toBe("IntroTail");
    expect(normalizeThinkingTags(`A${T_CLOSE}B${T_CLOSE}C`)).toBe("ABC");
  });

  it("KEEPS an unmatched opener — mid-stream that block is still arriving", () => {
    expect(normalizeThinkingTags(`Intro${T_OPEN}partial`)).toBe(
      `Intro${CANON_OPEN}partial`,
    );
  });

  it("leaves a well-formed nested pair intact rather than treating the inner closer as orphaned", () => {
    const nested = `${CANON_OPEN}a${CANON_OPEN}b${CANON_CLOSE}c${CANON_CLOSE}`;
    expect(normalizeThinkingTags(nested)).toBe(nested);
  });

  it("passes through content with no thinking tags", () => {
    expect(normalizeThinkingTags("just prose")).toBe("just prose");
    expect(normalizeThinkingTags("")).toBe("");
  });
});

describe("extractVisibleAnswerMarkdown — tail must survive", () => {
  it("strips a balanced <think> block (pre-existing behaviour, must not regress)", () => {
    expect(
      extractVisibleAnswerMarkdown(`Intro${T_OPEN}SECRET${T_CLOSE}Tail`),
    ).toBe("IntroTail");
  });

  it("strips a balanced <thinking> block WITHOUT deleting the tail", () => {
    // Regression: the mismatched rewrite left an unclosed <redacted_thinking>,
    // and drop-through-eof ate everything after it — this returned "Intro".
    expect(
      extractVisibleAnswerMarkdown(`Intro${ING_OPEN}SECRET${ING_CLOSE}Tail`),
    ).toBe("IntroTail");
  });

  it("does not blank a reply that OPENS with <thinking>", () => {
    // Regression: the opener sat at index 0, so the whole message was sliced away
    // and this returned "".
    expect(
      extractVisibleAnswerMarkdown(`${ING_OPEN}SECRET${ING_CLOSE}Tail`),
    ).toBe("Tail");
    expect(
      extractVisibleAnswerMarkdown(`${ING_OPEN}SECRET${ING_CLOSE}Tail`),
    ).not.toContain("SECRET");
  });

  it("removes an orphan closer instead of rendering it as prose", () => {
    // Regression: the MiniMax M3 artifact — a bare </think> shown to the user.
    const out = extractVisibleAnswerMarkdown(`Intro${T_CLOSE}Tail`);
    expect(out).toBe("IntroTail");
    expect(out).not.toContain("think");
  });

  it("handles a MiniMax-shaped transcript: orphan closer then real prose", () => {
    const raw = `Hey! Doing well.${T_CLOSE}\n\nAbout this project: it is a quote app.`;
    const out = extractVisibleAnswerMarkdown(raw);
    expect(out).not.toContain("think");
    expect(out).toContain("Hey! Doing well.");
    expect(out).toContain("About this project");
  });

  it("still drops an unclosed <think> through EOF (deliberate streaming behaviour)", () => {
    expect(extractVisibleAnswerMarkdown(`Intro${T_OPEN}SECRET`)).toBe("Intro");
  });
});

describe("extractThinkingFromContent — reasoning must not swallow the answer", () => {
  it("captures ONLY the reasoning for a <think> block", () => {
    // Regression: modelReasoning was "SECRET</think>Tail" for every model that
    // emits <think> (DeepSeek included), so the Thoughts card showed the answer.
    const snap = extractThinkingFromContent(`Intro${T_OPEN}SECRET${T_CLOSE}Tail`);
    expect(snap.modelReasoning).toBe("SECRET");
    expect(snap.modelReasoning).not.toContain("Tail");
    expect(snap.modelReasoning).not.toContain("think");
  });

  it("captures ONLY the reasoning for a <thinking> block", () => {
    const snap = extractThinkingFromContent(
      `Intro${ING_OPEN}SECRET${ING_CLOSE}Tail`,
    );
    expect(snap.modelReasoning).toBe("SECRET");
    expect(snap.modelReasoning).not.toContain("Tail");
  });
});

describe("parseAssistantMessageParts — the tail keeps its own markdown part", () => {
  it("emits markdown before AND after a <thinking> block", () => {
    // Regression: the appended closer landed at end-of-content, so the tail was
    // absorbed into the thought part and never rendered.
    const parts = parseAssistantMessageParts(
      `Intro${ING_OPEN}SECRET${ING_CLOSE}Tail`,
      false,
    );
    const markdown = parts
      .filter((p): p is { type: "markdown"; content: string } => p.type === "markdown")
      .map((p) => p.content);
    expect(markdown).toContain("Intro");
    expect(markdown).toContain("Tail");
    expect(parts.some((p) => p.type === "thought")).toBe(true);
  });

  it("does not leak an orphan closer into a markdown part", () => {
    const parts = parseAssistantMessageParts(`Intro${T_CLOSE}Tail`, false);
    const joined = parts
      .filter((p): p is { type: "markdown"; content: string } => p.type === "markdown")
      .map((p) => p.content)
      .join("");
    expect(joined).toBe("IntroTail");
    expect(joined).not.toContain("think");
  });
});
