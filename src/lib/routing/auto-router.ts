/**
 * Auto router: Groq tier classifier → user fast-model word → balanced fallback,
 * then applyCeiling → applyTierFloor → resolve model.
 */

import type { UserSettings } from "../schemas";
import type { LargeLanguageModel } from "../schemas";
import type { GetModelClientOptions } from "@/ipc/utils/get_model_client";
import { getFastModelForCurrentProvider, getModelClient } from "@/ipc/utils/get_model_client";
import { generateText } from "ai";
import type { RoutingCategory } from "./signal-sets";
import { resolveTierToModel } from "./fallback-router";
import type { ModelTier } from "./capability-registry";
import { classifyPromptWithGroq } from "./groq-classifier";

const GROQ_CONFIDENCE_MIN = 0.65;
const FAST_MODEL_CLASSIFY_MS = 1500;

export type ClassifierSource = "groq" | "fast-model" | "fallback";

export interface AutoRouterClassifierMeta {
  tier: ModelTier;
  confidence: number | null;
  source: ClassifierSource;
}

function tierToSyntheticCategory(tier: ModelTier): RoutingCategory {
  switch (tier) {
    case "fast":
      return "simple_edit";
    case "balanced":
      return "code_generation";
    case "thinking":
      return "complex_reasoning";
    default:
      return "code_generation";
  }
}

function parseTierFromWord(text: string): ModelTier | null {
  const raw = text.trim();
  if (!raw) return null;
  const word = raw.split(/\s+/)[0] ?? "";
  const w = word.replace(/[^a-zA-Z]/g, "").toLowerCase();
  if (!w) return null;
  if (w === "fast" || w.startsWith("fast")) return "fast";
  if (w === "balanced" || w === "balance" || w.startsWith("balanc")) return "balanced";
  if (w === "thinking" || w.startsWith("think")) return "thinking";
  return null;
}

async function classifyTierWithUserFastModel(
  query: string,
  settings: UserSettings,
  options: GetModelClientOptions | undefined
): Promise<ModelTier | null> {
  const fastModel = getFastModelForCurrentProvider(settings);
  if (!fastModel) return null;
  try {
    const { modelClient } = await getModelClient(fastModel, settings, options);
    const instruction =
      "Classify this prompt as fast, balanced, or thinking for an AI coding assistant. Respond with ONLY one word.";
    const res = await Promise.race([
      generateText({
        model: modelClient.model,
        messages: [
          {
            role: "user",
            content: `${instruction}\n\n${query.slice(0, 4000)}`,
          },
        ],
        temperature: 0,
        maxTokens: 20,
      } as Parameters<typeof generateText>[0]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), FAST_MODEL_CLASSIFY_MS)
      ),
    ]);
    const raw = String((res as { text?: string })?.text ?? "").trim();
    return parseTierFromWord(raw);
  } catch {
    return null;
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

/**
 * Minimum tier after ceiling: autonomous main and guided main in plan/build/debug never below balanced.
 */
function applyTierFloor(
  tier: ModelTier,
  settings: UserSettings,
  options: GetModelClientOptions | undefined
): ModelTier {
  const mode = options?.agentMode ?? settings.agentMode ?? "guided";
  const role = options?.delegationRole ?? "main";
  const work = settings.workModePreference ?? "ask";

  const tierOrder: ModelTier[] = ["fast", "balanced", "thinking"];
  const tierIdx = tierOrder.indexOf(tier);
  let floorIdx = 0;

  if (role === "main") {
    if (mode === "autonomous") {
      floorIdx = 1;
    } else if (
      mode === "guided" &&
      (work === "plan" || work === "build" || work === "debug")
    ) {
      floorIdx = 1;
    }
  }

  return tierOrder[Math.max(tierIdx, floorIdx)];
}

export interface RoutingDecision {
  targetModel: string;
  targetProvider: string;
  category: RoutingCategory;
  tier: ModelTier;
  /** Optional: suggests a specialist agent when category implies it. */
  recommendedAgent?: "research" | "architect" | "builder" | "debugger" | "reviewer";
}

export interface ModeRoutingDecision {
  recommended_mode: "ask" | "plan" | "build" | "debug" | "review";
  agent_sequence: Array<"ask" | "plan" | "build" | "debug" | "review">;
  reason: string;
  requires_confirmation: boolean;
}

export function recommendModeRoute(params: {
  prompt: string;
  hasPlan: boolean;
  activeBuild: boolean;
  lastMode?: "ask" | "plan" | "build" | "debug" | "review";
}): ModeRoutingDecision {
  const p = params.prompt.toLowerCase();
  const looksLikeBug =
    /\bbug|broken|error|failing|fix this|stack trace|typeerror|referenceerror|syntaxerror\b/.test(p);
  if (looksLikeBug) {
    return {
      recommended_mode: "debug",
      agent_sequence: ["debug"],
      reason: "Prompt indicates a runtime or failing behavior issue.",
      requires_confirmation: true,
    };
  }
  if (params.activeBuild) {
    return {
      recommended_mode: "build",
      agent_sequence: ["build", "review"],
      reason: "An active build flow exists; continue implementation then review.",
      requires_confirmation: false,
    };
  }
  const asksForImplementation =
    /\bimplement|build|create|add|refactor|wire|integrate|ship\b/.test(p);
  if (asksForImplementation && !params.hasPlan) {
    return {
      recommended_mode: "plan",
      agent_sequence: ["plan", "build"],
      reason: "Implementation requested without an existing plan.",
      requires_confirmation: true,
    };
  }
  if (asksForImplementation && params.hasPlan) {
    return {
      recommended_mode: "build",
      agent_sequence: ["build", "review"],
      reason: "Implementation requested and plan is available.",
      requires_confirmation: true,
    };
  }
  return {
    recommended_mode: "ask",
    agent_sequence: ["ask"],
    reason: "Defaulting to exploration/explanation.",
    requires_confirmation: false,
  };
}

function categoryToRecommendedAgent(
  category: RoutingCategory
): RoutingDecision["recommendedAgent"] {
  switch (category) {
    case "deep_research":
      return "research";
    case "architecture":
      return "architect";
    case "code_generation":
    case "simple_edit":
      return "builder";
    case "debugging":
      return "debugger";
    case "security_review":
      return "reviewer";
    default:
      return undefined;
  }
}

/**
 * Async auto router: Groq classifier (optional) → fast-model one-word → balanced default;
 * then ceiling, tier floor, resolve model.
 */
export async function runAutoRouterAsync(
  query: string,
  settings: UserSettings,
  options: GetModelClientOptions | undefined
): Promise<{
  decision: RoutingDecision;
  model: LargeLanguageModel;
  classifierMeta: AutoRouterClassifierMeta;
}> {
  let tier: ModelTier;
  let confidence: number | null = null;
  let source: ClassifierSource = "fallback";

  const groq = await classifyPromptWithGroq(query);
  if (groq && groq.confidence >= GROQ_CONFIDENCE_MIN) {
    tier = groq.tier;
    confidence = groq.confidence;
    source = "groq";
  } else {
    const fastTier = await classifyTierWithUserFastModel(query, settings, options);
    if (fastTier) {
      tier = fastTier;
      source = "fast-model";
    } else {
      tier = "balanced";
      source = "fallback";
    }
  }

  let finalTier = tier;
  finalTier = applyCeiling(finalTier, settings, options);
  finalTier = applyTierFloor(finalTier, settings, options);
  const syntheticCategory = tierToSyntheticCategory(finalTier);
  const model = resolveTierToModel(settings, finalTier);

  return {
    decision: {
      targetModel: model.name,
      targetProvider: model.provider,
      category: syntheticCategory,
      tier: finalTier,
      recommendedAgent: categoryToRecommendedAgent(syntheticCategory),
    },
    model,
    classifierMeta: {
      tier: finalTier,
      confidence,
      source,
    },
  };
}
