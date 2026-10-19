/**
 * A turn's max output tokens and temperature belong to the model the turn RUNS
 * on, not to the desktop app's selection.
 *
 * THE BUG (owner, CLI, 2026-10-19): the app was on DeepSeek V4 Pro (393,216
 * output tokens) while the CLI's Explore agent ran Claude Haiku 5.5 (128,000).
 * The request went to Haiku with DeepSeek's limit and Anthropic refused it:
 *
 *   max_tokens: 393216 > 128000, which is the maximum allowed number of output
 *   tokens for claude-haiku-5-5
 *
 * Both were sized from `settings.selectedModel` while the model client honoured
 * the request's `modelOverride` (the CLI's model, a user agent's, a sub-agent's).
 * Haiku 5.5 also takes no temperature, and DeepSeek's row said it did.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageModel } from "@/ipc/ipc_types";
import type { LargeLanguageModel, UserSettings } from "@/lib/schemas";

const ROWS: Record<string, LanguageModel> = {
  "deepseek:deepseek-v4-pro": {
    apiName: "deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    maxOutputTokens: 393_216,
    type: "cloud",
  } as LanguageModel,
  "anthropic:claude-haiku-5-5": {
    apiName: "claude-haiku-5-5",
    displayName: "Claude Haiku 5.5",
    maxOutputTokens: 128_000,
    type: "cloud",
  } as LanguageModel,
};

vi.mock("@/ipc/utils/findLanguageModel", () => ({
  findLanguageModel: async (m: LargeLanguageModel) => ROWS[`${m.provider}:${m.name}`],
}));

import {
  maxOutputTokensForTurn,
  temperatureForTurn,
} from "@/ipc/handlers/chat_stream/turn-runner/simple-stream-text";
import {
  __resetReasoningRegistryForTests,
  registerModelsDevReasoning,
} from "@/lib/routing/model-reasoning-profile";

const DEEPSEEK: LargeLanguageModel = { provider: "deepseek", name: "deepseek-v4-pro" };
const HAIKU: LargeLanguageModel = { provider: "anthropic", name: "claude-haiku-5-5" };

/** The app's choice, as on the owner's machine. */
const settings = { selectedModel: DEEPSEEK } as UserSettings;

describe("a turn's output options follow the turn's own model", () => {
  beforeEach(() => {
    __resetReasoningRegistryForTests();
    // The catalog rows' temperature flags, as the bundled snapshot has them.
    registerModelsDevReasoning([
      {
        providerId: "deepseek",
        modelId: "deepseek-v4-pro",
        profile: { reasoning: true, options: [] },
        supportsTemperature: true,
      },
      {
        providerId: "anthropic",
        modelId: "claude-haiku-5-5",
        profile: { reasoning: true, options: [] },
        supportsTemperature: false,
      },
    ]);
  });

  it("sizes max output tokens for the turn's model, not the app's", async () => {
    expect(
      await maxOutputTokensForTurn({ settings, effectiveModel: HAIKU, enableNativeReasoning: true }),
    ).toBe(128_000);
  });

  it("omits temperature for a model that takes none, whatever the app's model takes", async () => {
    expect(await temperatureForTurn({ settings, effectiveModel: HAIKU })).toBeUndefined();
  });

  it("still uses the app's model when the turn runs on it", async () => {
    expect(
      await maxOutputTokensForTurn({ settings, effectiveModel: DEEPSEEK, enableNativeReasoning: true }),
    ).toBe(393_216);
    expect(await temperatureForTurn({ settings, effectiveModel: DEEPSEEK })).toBe(0);
  });
});
