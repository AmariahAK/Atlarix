/**
 * Two-stage auto router: classify query → tier (with ceiling) → resolve model.
 * Stage 1: heuristic keyword signals; Stage 2: fast model when confidence < 0.85.
 */

import type { UserSettings } from "../schemas";
import type { LargeLanguageModel } from "../schemas";
import type { GetModelClientOptions } from "@/ipc/utils/get_model_client";
import {
  ARCHITECTURE_SIGNALS,
  DEBUG_SIGNALS,
  RESEARCH_SIGNALS,
  SECURITY_SIGNALS,
  REASONING_SIGNALS,
  CODE_GENERATION_SIGNALS,
  SIMPLE_EDIT_SIGNALS,
  CHIT_CHAT_PATTERNS,
  type RoutingCategory,
} from "./signal-sets";
import { resolveTierToModel } from "./fallback-router";
import type { ModelTier } from "./capability-registry";

const CONFIDENCE_THRESHOLD = 0.85;

function countSignals(text: string, signals: string[]): number {
  const lower = text.toLowerCase();
  return signals.filter((s) => lower.includes(s)).length;
}

function matchChitChat(text: string): boolean {
  const trimmed = text.trim();
  return CHIT_CHAT_PATTERNS.some((p) => p.test(trimmed));
}

/**
 * Stage 1: heuristic classification. Returns category and confidence 0..1.
 */
export function classifyHeuristic(
  query: string
): { category: RoutingCategory; confidence: number } {
  const text = query.trim();
  if (!text) {
    return { category: "chit_chat", confidence: 1 };
  }

  if (matchChitChat(text)) {
    return { category: "chit_chat", confidence: 0.95 };
  }

  const arch = countSignals(text, ARCHITECTURE_SIGNALS);
  const debug = countSignals(text, DEBUG_SIGNALS);
  const research = countSignals(text, RESEARCH_SIGNALS);
  const security = countSignals(text, SECURITY_SIGNALS);
  const reasoning = countSignals(text, REASONING_SIGNALS);
  const codeGen = countSignals(text, CODE_GENERATION_SIGNALS);
  const simpleEdit = countSignals(text, SIMPLE_EDIT_SIGNALS);

  const scores: { category: RoutingCategory; score: number }[] = [
    { category: "architecture", score: arch },
    { category: "debugging", score: debug },
    { category: "deep_research", score: research },
    { category: "security_review", score: security },
    { category: "complex_reasoning", score: reasoning },
    { category: "code_generation", score: codeGen },
    { category: "simple_edit", score: simpleEdit },
  ].filter((s) => s.score > 0);

  if (scores.length === 0) {
    return { category: "complex_reasoning", confidence: 0.3 };
  }

  scores.sort((a, b) => b.score - a.score);
  const top = scores[0];
  const second = scores[1];
  const total = scores.reduce((t, s) => t + s.score, 0);
  const confidence =
    total >= 3 ? Math.min(0.85, 0.4 + top.score * 0.15) : 0.4 + top.score * 0.1;
  const normalized =
    second && second.score === top.score
      ? Math.min(confidence, 0.7)
      : confidence;

  return {
    category: top.category,
    confidence: Math.min(1, normalized),
  };
}

/**
 * Map category to tier (fast / balanced / thinking).
 */
export function categoryToTier(category: RoutingCategory): ModelTier {
  switch (category) {
    case "chit_chat":
    case "simple_edit":
      return "fast";
    case "debugging":
    case "code_generation":
    case "architecture":
    case "deep_research":
      return "balanced";
    case "security_review":
    case "complex_reasoning":
      return "thinking";
    default:
      return "balanced";
  }
}

/**
 * Apply ceiling by mode/role (Guided: main=balanced agents=fast; Autonomous: main=thinking agents=balanced subagents=fast).
 */
function applyCeiling(
  tier: ModelTier,
  settings: UserSettings,
  options: GetModelClientOptions | undefined
): ModelTier {
  const mode = options?.agentMode ?? settings.agentMode ?? "guided";
  const role = options?.delegationRole ?? "main";
  const depth = options?.delegationDepth ?? 0;

  const tierOrder: ModelTier[] = ["fast", "balanced", "thinking"];
  const tierIdx = tierOrder.indexOf(tier);
  let ceilingIdx: number;

  if (role === "main") {
    ceilingIdx = mode === "autonomous" ? 2 : 1; // thinking : balanced
  } else if (role === "agent") {
    ceilingIdx = mode === "autonomous" && depth === 0 ? 1 : 0; // balanced : fast
  } else {
    ceilingIdx = 0; // subagent = fast
  }

  const cappedIdx = Math.min(tierIdx, ceilingIdx);
  return tierOrder[cappedIdx];
}

export interface RoutingDecision {
  targetModel: string;
  targetProvider: string;
  category: RoutingCategory;
  tier: ModelTier;
}

/**
 * Run auto router: Stage 1 classification, optional Stage 2 (caller may do LLM call), then resolve model with ceiling and fallback.
 */
export function runAutoRouter(
  query: string,
  settings: UserSettings,
  options?: GetModelClientOptions
): { decision: RoutingDecision; model: LargeLanguageModel } {
  const { category, confidence } = classifyHeuristic(query);

  let finalCategory = category;
  // Stage 2 would run here if confidence < CONFIDENCE_THRESHOLD (e.g. call fast model for "category:confidence").
  // For now we use heuristic only; Stage 2 can be added later with a fast model call.
  if (confidence < CONFIDENCE_THRESHOLD) {
    // Keep heuristic result; optional: await classifyWithLLM(query, settings) -> finalCategory
  }

  let tier = categoryToTier(finalCategory);
  tier = applyCeiling(tier, settings, options);
  const model = resolveTierToModel(settings, tier);

  return {
    decision: {
      targetModel: model.name,
      targetProvider: model.provider,
      category: finalCategory,
      tier,
    },
    model,
  };
}
