/**
 * Heuristic classifier sanity tests. The classifier is the third-tier fallback
 * for `auto-router.ts` and the gate behind mid-stream tier escalation. It must:
 *   - return `fast` for short throwaway prompts
 *   - return `balanced` or `thinking` for architecture / refactor prompts
 *   - upgrade when mid-stream token pressure crosses 60%
 *   - never escalate when running tokens are below the budget
 */

import { describe, it, expect } from "vitest";
import {
  classifyTierWithHeuristic,
  isHigherTier,
  maybeEscalateTier,
  tierRank,
  MID_STREAM_ESCALATION_TOKEN_RATIO,
} from "../lib/routing/heuristic-classifier";

describe("classifyTierWithHeuristic", () => {
  it("returns fast for tiny throwaway prompts", () => {
    const result = classifyTierWithHeuristic({
      prompt: "rename this var to foo",
    });
    expect(result.tier).toBe("fast");
    expect(result.score).toBeLessThan(0.3);
  });

  it("returns fast for trivial typo prompts (simple-edit penalty)", () => {
    const result = classifyTierWithHeuristic({
      prompt: "fix typo in README",
    });
    expect(result.tier).toBe("fast");
  });

  it("escalates architectural refactor prompts", () => {
    const result = classifyTierWithHeuristic({
      prompt:
        "Refactor the architecture of the auth module across the codebase, then migrate the schema and rewrite the data model.",
    });
    expect(["balanced", "thinking"]).toContain(result.tier);
    expect(result.signals.architectureHits).toBeGreaterThan(0);
  });

  it("plan mode with code mentions increases complexity vs ask-only", () => {
    const prompt =
      "Design a strategy for migrating the auth module. Include src/auth/login.ts, src/auth/session.ts and packages/api/middleware.ts. Cover trade-offs.";
    const askResult = classifyTierWithHeuristic({ mode: "ask", prompt });
    const planResult = classifyTierWithHeuristic({ mode: "plan", prompt });
    expect(planResult.signals.fileMentions).toBeGreaterThan(0);
    expect(planResult.score).toBeGreaterThanOrEqual(askResult.score);
    expect(["fast", "balanced", "thinking"]).toContain(planResult.tier);
  });

  it("respects mode boost for plan mode on borderline prompts", () => {
    const plainResult = classifyTierWithHeuristic({
      prompt: "outline a basic approach for the dashboard",
    });
    const planResult = classifyTierWithHeuristic({
      mode: "plan",
      prompt: "outline a basic approach for the dashboard",
    });
    expect(planResult.score).toBeGreaterThan(plainResult.score);
  });

  it("returns thinking for long, code-fence-heavy prompts", () => {
    const longBody =
      "We need to refactor and redesign the architecture across services.\n" +
      "```ts\nfunction a() {}\n```\n```ts\nfunction b() {}\n```\n";
    const result = classifyTierWithHeuristic({
      prompt: longBody.repeat(30),
    });
    expect(result.tier).toBe("thinking");
    expect(result.confidence).toBeGreaterThan(0.4);
  });

  it("adds mid-stream pressure when runningTokens crosses 60% of budget", () => {
    const base = classifyTierWithHeuristic({
      prompt: "look at this file please",
    });
    const escalated = classifyTierWithHeuristic({
      prompt: "look at this file please",
      runningTokens: 80_000,
      tierTokenBudget: 100_000,
    });
    expect(escalated.score).toBeGreaterThan(base.score);
    expect(escalated.signals.midStreamPressure).toBeGreaterThan(
      MID_STREAM_ESCALATION_TOKEN_RATIO,
    );
  });

  it("does NOT add mid-stream pressure under 60%", () => {
    const result = classifyTierWithHeuristic({
      prompt: "small ask",
      runningTokens: 1000,
      tierTokenBudget: 100_000,
    });
    expect(result.tier).toBe("fast");
    expect(result.signals.midStreamPressure).toBeLessThan(
      MID_STREAM_ESCALATION_TOKEN_RATIO,
    );
  });

  it("respects tier ordering helpers", () => {
    expect(tierRank("fast")).toBe(0);
    expect(tierRank("balanced")).toBe(1);
    expect(tierRank("thinking")).toBe(2);
    expect(isHigherTier("thinking", "balanced")).toBe(true);
    expect(isHigherTier("balanced", "fast")).toBe(true);
    expect(isHigherTier("fast", "fast")).toBe(false);
    expect(isHigherTier("balanced", "thinking")).toBe(false);
  });

  it("never returns confidence above 0.85 (advisory cap)", () => {
    const result = classifyTierWithHeuristic({
      prompt:
        "Re-architect the entire distributed system, migrate the schema, refactor the data model, and rewrite the concurrency primitives across the codebase end-to-end.".repeat(
          10,
        ),
    });
    expect(result.confidence).toBeLessThanOrEqual(0.85);
  });
});

describe("maybeEscalateTier", () => {
  const heavyPrompt =
    "Refactor the architecture across the codebase and migrate the schema end-to-end.";

  it("returns null when tierSource is not auto (manual selection)", () => {
    expect(
      maybeEscalateTier({
        agenticIteration: 4,
        iterationInterval: 4,
        runningTokens: 10_000,
        tierTokenBudget: 100_000,
        tierSource: "user_setting",
        currentTier: "fast",
        prompt: heavyPrompt,
        mode: "build",
      }),
    ).toBeNull();
    expect(
      maybeEscalateTier({
        agenticIteration: 4,
        iterationInterval: 4,
        runningTokens: 10_000,
        tierTokenBudget: 100_000,
        tierSource: "override",
        currentTier: "fast",
        prompt: heavyPrompt,
        mode: "build",
      }),
    ).toBeNull();
  });

  it("returns null when agenticIteration is 0", () => {
    expect(
      maybeEscalateTier({
        agenticIteration: 0,
        iterationInterval: 4,
        runningTokens: 90_000,
        tierTokenBudget: 100_000,
        tierSource: "auto",
        currentTier: "fast",
        prompt: heavyPrompt,
        mode: "build",
      }),
    ).toBeNull();
  });

  it("escalates in auto mode on iteration interval with higher heuristic tier", () => {
    const out = maybeEscalateTier({
      agenticIteration: 4,
      iterationInterval: 4,
      runningTokens: 1000,
      tierTokenBudget: 100_000,
      tierSource: "auto",
      currentTier: "fast",
      prompt: heavyPrompt,
      mode: "build",
    });
    expect(out).not.toBeNull();
    if (!out) throw new Error("unreachable");
    expect(out.newTier).not.toBe("fast");
  });
});
