import { PROVIDERS_THAT_SUPPORT_THINKING } from "../shared/language_model_constants";
import type { UserSettings } from "../../lib/schemas";

/**
 * The reasoning effort applied to a request. Atlarix uses a flat `medium`
 * baseline for every model/provider/mode; the single `deepThinking` toggle
 * raises it to `high` (each provider's max reasoning) on demand. There is
 * deliberately no `low` — the only user choice is the on/off toggle.
 */
export type ReasoningEffort = "medium" | "high";

/** Resolve the effort for a request from the one binary toggle. */
export function getReasoningEffort(settings?: UserSettings): ReasoningEffort {
  return settings?.deepThinking ? "high" : "medium";
}

function getThinkingBudgetTokens(effort: ReasoningEffort): number {
  // high → -1 (dynamic; the model self-regulates its thinking budget).
  return effort === "high" ? -1 : 4_000;
}

export function getExtraProviderOptions(
  providerId: string | undefined,
  settings: UserSettings,
  /** When false, omit extended thinking / reasoning-effort (fast & balanced tiers). */
  includeExtendedThinking = false,
): Record<string, any> {
  if (!providerId) {
    return {};
  }
  if (!includeExtendedThinking) {
    return {};
  }
  const effort = getReasoningEffort(settings);
  if (providerId === "openai") {
    return {
      reasoning_effort: effort,
    };
  }
  if (PROVIDERS_THAT_SUPPORT_THINKING.includes(providerId)) {
    const budgetTokens = getThinkingBudgetTokens(effort);
    return {
      thinking: {
        type: "enabled",
        include_thoughts: true,
        // -1 means dynamic thinking where model determines.
        // budget_tokens: 128, // minimum for Gemini Pro is 128
        budget_tokens: budgetTokens,
      },
    };
  }
  return {};
}
