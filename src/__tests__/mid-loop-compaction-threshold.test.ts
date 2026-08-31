import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import {
  COMPACTION_THRESHOLD,
  midLoopCompactionWouldTrigger,
} from "@/lib/context/mid-loop-threshold";

/**
 * Mid-TASK compaction: a long agentic turn must be able to cross the context
 * limit, compact itself between tool rounds, and keep going.
 *
 * The trigger is overflow-only (0.9 of the real window) rather than the old 0.75
 * — compacting a turn that still has room is what made earlier versions lose
 * detail it never needed to lose. It runs inside the agentic `for(;;)` loop
 * AFTER each round's tool results land (`run-agent-turn.ts`), so the next
 * iteration continues from the compacted history.
 *
 * The property that actually matters for "continues without errors" is that a
 * failing summarizer is NON-FATAL: the wrapper returns the original messages so
 * a flaky provider call can never abort a tool loop mid-task.
 */

// Small on purpose: `estimateTokens` runs an EXACT tokenizer, so fixtures sized
// like a real window (800KB strings) take minutes to score. The predicate is
// pure ratio maths — it does not care about the magnitude.
const WINDOW = 1_000;

/** A message whose exact token count is `tokens` (one token per " a"-ish word). */
function msgsOfRoughly(tokens: number): ModelMessage[] {
  return [{ role: "user", content: "word ".repeat(tokens) } as ModelMessage];
}

const trigger = (tokens: number, threshold?: number) =>
  midLoopCompactionWouldTrigger({
    messages: msgsOfRoughly(tokens),
    systemPromptEstimate: 0,
    tierLimit: WINDOW,
    contextWindowTokens: WINDOW,
    ...(threshold != null ? { threshold } : {}),
  });

describe("mid-task compaction threshold", () => {
  it("fires at 90% of the window", () => {
    expect(trigger(900).willTrigger).toBe(true);
  });

  it("does NOT fire just below it — a turn with room keeps its detail", () => {
    expect(trigger(880).willTrigger).toBe(false);
    expect(trigger(500).willTrigger).toBe(false);
  });

  it("fires when well over", () => {
    expect(trigger(1_500).willTrigger).toBe(true);
  });

  it("counts the system prompt toward the fill, not just the messages", () => {
    // 850 of history alone is under; add a 100-token system prompt and it crosses.
    const under = midLoopCompactionWouldTrigger({
      messages: msgsOfRoughly(850),
      systemPromptEstimate: 0,
      tierLimit: WINDOW,
      contextWindowTokens: WINDOW,
    });
    const over = midLoopCompactionWouldTrigger({
      messages: msgsOfRoughly(850),
      systemPromptEstimate: 100,
      tierLimit: WINDOW,
      contextWindowTokens: WINDOW,
    });
    expect(under.willTrigger).toBe(false);
    expect(over.willTrigger).toBe(true);
  });

  it("measures against the real context window, not the tier limit, when given", () => {
    // A large-window model must not compact at 90% of a smaller tier limit.
    const r = midLoopCompactionWouldTrigger({
      messages: msgsOfRoughly(2_000),
      systemPromptEstimate: 0,
      tierLimit: 2_000,
      contextWindowTokens: 10_000,
    });
    expect(r.willTrigger).toBe(false);
  });
});

describe("the threshold has ONE source", () => {
  it("is 0.9 and is what the predicate defaults to", () => {
    expect(COMPACTION_THRESHOLD).toBe(0.9);
    // Exactly at the line triggers; a hair under does not.
    expect(trigger(900).willTrigger).toBe(true);
    expect(trigger(880).willTrigger).toBe(false);
  });

  it("an explicit threshold still overrides it", () => {
    expect(trigger(600, 0.5).willTrigger).toBe(true);
    expect(trigger(600, 0.95).willTrigger).toBe(false);
  });
});
