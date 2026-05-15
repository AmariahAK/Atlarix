/**
 * Third-tier fallback classifier used by the auto-router and the mid-stream
 * escalation guard when:
 *   1. the Groq classifier is unavailable / low-confidence, AND
 *   2. the user-provider fast-model classifier did not produce a one-word answer.
 *
 * Local, deterministic, ~O(n) over the prompt. Never makes a network call.
 *
 * Signals (combined into a 0-1 complexity score):
 *   - rough token estimate (prompt length / 4)
 *   - code blocks (``` …```), file mentions (`@path` or `path/with/slashes`)
 *   - architecture / refactor / cross-cutting keywords
 *   - explicit agentic intent (plan / design / migrate / end-to-end)
 *   - small-edit hints (typo fix, rename, "tiny" — push back toward fast)
 *
 * Then maps:
 *   score < 0.30 → fast
 *   0.30 ≤ score < 0.60 → balanced
 *   score ≥ 0.60 → thinking
 *
 * On any ambiguity we lean `balanced` (safer than fast for the fallback path).
 */

import type { ModelTier } from "./capability-registry";

export const MID_STREAM_ESCALATION_TOKEN_RATIO = 0.6;
export const MID_STREAM_ESCALATION_ITERATION_INTERVAL = 4;

const ARCHITECTURE_KEYWORDS = [
  "architecture",
  "architectural",
  "design system",
  "refactor",
  "refactoring",
  "redesign",
  "migrate",
  "migration",
  "rewrite",
  "rewriting",
  "across the codebase",
  "cross-cutting",
  "end-to-end",
  "end to end",
  "implement.*end[- ]to[- ]end",
  "system design",
  "blueprint",
  "scaffolding",
  "scaffold the",
  "fix all",
  "audit",
  "performance optimization",
  "concurrency",
  "race condition",
  "deadlock",
  "distributed",
  "scalability",
  "data model",
  "schema migration",
  "module boundary",
];

const COMPLEX_REASONING_KEYWORDS = [
  "why does",
  "why is",
  "explain the trade-?off",
  "compare and contrast",
  "step by step",
  "step-by-step",
  "prove that",
  "derive",
  "reason about",
  "root cause",
  "debug the underlying",
  "deeply analyze",
  "exhaustive",
  "trace through",
];

const PLAN_INTENT_KEYWORDS = [
  "plan ",
  "let's plan",
  "design a",
  "design the",
  "propose a",
  "outline a",
  "strategy for",
  "approach for",
  "options for",
  "trade-?offs",
];

const SIMPLE_EDIT_KEYWORDS = [
  "typo",
  "rename",
  "small fix",
  "tiny",
  "quick fix",
  "one[- ]liner",
  "comment out",
  "add a log",
  "console\\.log",
  "remove unused",
];

const FENCE_REGEX = /```/g;
const FILE_MENTION_REGEX = /(?:^|\s)@[\w./-]{2,}|\b[\w-]+\/[\w./-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|cs|cpp|cc|h|hpp|kt|swift|rb|php|sh|sql|yml|yaml|json|toml|md)\b/g;

export type HeuristicClassifierMode = "ask" | "plan" | "build" | "agent" | "unknown";

export interface HeuristicClassifierInput {
  prompt: string;
  mode?: HeuristicClassifierMode;
  /** Soft hint: rough tokens already consumed in the running turn (for mid-stream re-classification). */
  runningTokens?: number;
  /** Soft hint: total tier budget at dispatch (for mid-stream). */
  tierTokenBudget?: number;
}

export interface HeuristicClassifierSignals {
  estimatedTokens: number;
  codeFences: number;
  fileMentions: number;
  architectureHits: number;
  complexReasoningHits: number;
  planIntentHits: number;
  simpleEditHits: number;
  modeBoost: number;
  midStreamPressure: number;
}

export interface HeuristicClassifierResult {
  tier: ModelTier;
  confidence: number;
  score: number;
  signals: HeuristicClassifierSignals;
}

function countMatches(text: string, patterns: string[]): number {
  let total = 0;
  for (const pattern of patterns) {
    try {
      const re = new RegExp(`\\b${pattern}\\b`, "gi");
      const matches = text.match(re);
      if (matches) total += matches.length;
    } catch {
      // Skip malformed patterns silently — the keyword tables are static so
      // this is a guardrail for future edits, never expected at runtime.
    }
  }
  return total;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export function classifyTierWithHeuristic(
  input: HeuristicClassifierInput,
): HeuristicClassifierResult {
  const text = (input.prompt ?? "").toString();
  const estimatedTokens = Math.ceil(text.length / 4);
  const codeFences = Math.floor((text.match(FENCE_REGEX)?.length ?? 0) / 2);
  const fileMentions = text.match(FILE_MENTION_REGEX)?.length ?? 0;
  const architectureHits = countMatches(text, ARCHITECTURE_KEYWORDS);
  const complexReasoningHits = countMatches(text, COMPLEX_REASONING_KEYWORDS);
  const planIntentHits = countMatches(text, PLAN_INTENT_KEYWORDS);
  const simpleEditHits = countMatches(text, SIMPLE_EDIT_KEYWORDS);

  const mode = input.mode ?? "unknown";
  // Plan / agent / build modes already imply a heavier turn — give them a
  // small upward nudge so a one-line prompt in plan mode still escalates.
  const modeBoost =
    mode === "plan" || mode === "agent"
      ? 0.15
      : mode === "build"
        ? 0.08
        : 0;

  // Mid-stream pressure: how close we are to the tier's token budget. Once
  // we cross MID_STREAM_ESCALATION_TOKEN_RATIO we add a strong upward signal.
  const midStreamPressure =
    input.runningTokens && input.tierTokenBudget && input.tierTokenBudget > 0
      ? clamp01(input.runningTokens / input.tierTokenBudget)
      : 0;

  // Token-volume score: 800 tokens ≈ neutral, 4000+ ≈ heavy.
  const tokenScore = clamp01((estimatedTokens - 200) / 3800);

  // Keyword aggregation: each architecture / complex-reasoning hit is worth
  // ~0.12, plan-intent ~0.05, file-mention ~0.04, fence ~0.03.
  let keywordScore =
    architectureHits * 0.12 +
    complexReasoningHits * 0.1 +
    planIntentHits * 0.05 +
    Math.min(fileMentions, 8) * 0.04 +
    Math.min(codeFences, 5) * 0.03;
  keywordScore = clamp01(keywordScore);

  // Mid-stream pressure crossing the ratio adds a big upward signal.
  const midStreamScore =
    midStreamPressure > MID_STREAM_ESCALATION_TOKEN_RATIO ? 0.35 : 0;

  // Simple-edit hints reduce the score (push toward fast).
  const simpleEditPenalty = Math.min(simpleEditHits, 3) * 0.12;

  let score =
    tokenScore * 0.35 +
    keywordScore * 0.55 +
    modeBoost +
    midStreamScore -
    simpleEditPenalty;
  score = clamp01(score);

  let tier: ModelTier;
  if (score >= 0.6) tier = "thinking";
  else if (score >= 0.3) tier = "balanced";
  else tier = "fast";

  // Confidence reflects how far we are from the nearest decision boundary.
  // A score of 0.30 → "balanced" with low confidence; 0.85 → "thinking" with
  // high confidence. We never claim >0.85 to avoid spoofing the upstream
  // GROQ_CONFIDENCE_MIN gate (this classifier is deliberately advisory).
  const boundaryDistance =
    tier === "fast"
      ? 0.3 - score
      : tier === "balanced"
        ? Math.min(score - 0.3, 0.6 - score)
        : score - 0.6;
  const confidence = Math.min(0.85, 0.4 + clamp01(boundaryDistance * 2));

  return {
    tier,
    confidence,
    score,
    signals: {
      estimatedTokens,
      codeFences,
      fileMentions,
      architectureHits,
      complexReasoningHits,
      planIntentHits,
      simpleEditHits,
      modeBoost,
      midStreamPressure,
    },
  };
}

const TIER_ORDER: ModelTier[] = ["fast", "balanced", "thinking"];

export function tierRank(tier: ModelTier): number {
  return TIER_ORDER.indexOf(tier);
}

export function isHigherTier(a: ModelTier, b: ModelTier): boolean {
  return tierRank(a) > tierRank(b);
}

/** Dispatch-time tier source; only `"auto"` may mid-stream escalate. */
export type TierEscalationSource =
  | "user_setting"
  | "auto"
  | "override"
  | "force_thinking";

/**
 * Re-classify a running Auto-mode turn every N iterations or once total
 * running tokens cross 60% of the tier budget. Returns the new tier if it's
 * strictly higher than the current one, otherwise null.
 */
export function maybeEscalateTier(args: {
  agenticIteration: number;
  iterationInterval: number;
  runningTokens: number;
  tierTokenBudget: number;
  tierSource: TierEscalationSource;
  currentTier: ModelTier;
  prompt: string;
  mode: HeuristicClassifierMode;
}): { newTier: ModelTier; reason: string } | null {
  if (args.tierSource !== "auto") return null;
  if (args.agenticIteration <= 0) return null;
  const intervalGate =
    args.iterationInterval > 0 &&
    args.agenticIteration % args.iterationInterval === 0;
  const ratio =
    args.tierTokenBudget > 0 ? args.runningTokens / args.tierTokenBudget : 0;
  const pressureGate = ratio >= MID_STREAM_ESCALATION_TOKEN_RATIO;
  if (!intervalGate && !pressureGate) return null;
  const result = classifyTierWithHeuristic({
    prompt: args.prompt,
    mode: args.mode,
    runningTokens: args.runningTokens,
    tierTokenBudget: args.tierTokenBudget,
  });
  if (!isHigherTier(result.tier, args.currentTier)) return null;
  const reasonBits: string[] = [];
  if (intervalGate)
    reasonBits.push(
      `iter ${args.agenticIteration} ≥ ${args.iterationInterval}`,
    );
  if (pressureGate)
    reasonBits.push(`token pressure ${Math.round(ratio * 100)}% ≥ 60%`);
  if (result.signals.architectureHits > 0)
    reasonBits.push(`${result.signals.architectureHits} architecture hits`);
  return {
    newTier: result.tier,
    reason: reasonBits.join(" · ") || "heuristic upgrade",
  };
}
