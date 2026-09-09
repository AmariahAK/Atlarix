/**
 * Atlarix Core and the Deep-thinking toggle.
 *
 * The bug this locks down: Core models never offered Deep thinking, while the SAME
 * model reached through a BYOK key did. Three things had to be true at once —
 *
 *   1. the capability gate keyed on the raw provider (`compass`), a name no
 *      capability table contains, rather than the vendor the tier routes to;
 *   2. `detectReasoningCapability` can only recognise a reasoning route from a
 *      SLASHED OpenRouter id, and a direct-routed Core tier's catalog id is bare;
 *   3. so every Core model fell off the end of the fallback and answered "cannot
 *      reason", which hid the toggle for the whole lineup.
 *
 * These assertions are written against the tier ROUTING rather than any model name,
 * so adding a model to Core is a `core-models.json` edit and never a code change.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isReasoningCapableModel,
  resolveCapabilityProviderId,
  resolveReasoningCatalogModelId,
  resolveDispatchCapabilityProviderId,
  deriveReasoningCeiling,
} from "@/lib/routing/reasoning-detector";
import {
  registerModelsDevReasoning,
  __resetReasoningRegistryForTests,
} from "@/lib/routing/model-reasoning-profile";
import {
  setCoreModelRouting,
  __resetCoreModelOverridesForTests,
} from "@/ipc/shared/core-model-override-store";
import { getExtraProviderOptions } from "@/ipc/utils/thinking_utils";
import type { LargeLanguageModel, UserSettings } from "@/lib/schemas";

const CORE_TIER: LargeLanguageModel = {
  name: "core-3",
  provider: "compass",
} as LargeLanguageModel;

const BYOK_SAME_MODEL: LargeLanguageModel = {
  name: "deepseek-v4-pro",
  provider: "deepseek",
} as LargeLanguageModel;

/** The tier→vendor map the main process holds, as core-models.json supplies it. */
function routeCoreTierToDeepSeek(): void {
  setCoreModelRouting({
    "core-3": { provider: "deepseek", apiModelId: "deepseek-v4-pro" },
  });
}

function registerReasoner(): void {
  registerModelsDevReasoning([
    {
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
      profile: {
        reasoning: true,
        options: [
          { type: "toggle" },
          { type: "effort", values: ["high", "max"] },
        ],
      },
      supportsTemperature: true,
    },
  ]);
}

beforeEach(() => {
  __resetReasoningRegistryForTests();
  __resetCoreModelOverridesForTests();
});

afterEach(() => {
  __resetReasoningRegistryForTests();
  __resetCoreModelOverridesForTests();
});

describe("Core tier resolves to the vendor that actually serves it", () => {
  it("maps compass → the routed vendor and its own model id", () => {
    routeCoreTierToDeepSeek();
    expect(resolveCapabilityProviderId(CORE_TIER)).toBe("deepseek");
    expect(resolveReasoningCatalogModelId(CORE_TIER)).toBe("deepseek-v4-pro");
  });

  it("without routing it stays compass — the state the renderer used to see", () => {
    expect(resolveCapabilityProviderId(CORE_TIER)).toBe("compass");
    expect(resolveReasoningCatalogModelId(CORE_TIER)).toBe("core-3");
  });
});

describe("Deep-thinking availability is the model's, not the route's", () => {
  it("a Core tier serving a reasoner offers the toggle, exactly like BYOK", () => {
    routeCoreTierToDeepSeek();
    registerReasoner();
    expect(isReasoningCapableModel(CORE_TIER)).toBe(true);
    expect(isReasoningCapableModel(BYOK_SAME_MODEL)).toBe(true);
  });

  it("a Core tier serving a non-reasoner does NOT offer it", () => {
    setCoreModelRouting({
      "core-3": { provider: "deepseek", apiModelId: "deepseek-chat" },
    });
    registerModelsDevReasoning([
      {
        providerId: "deepseek",
        modelId: "deepseek-chat",
        profile: { reasoning: false, options: [] },
        supportsTemperature: true,
      },
    ]);
    expect(isReasoningCapableModel(CORE_TIER)).toBe(false);
  });

  it("a model that reasons with no control to change offers no toggle", () => {
    setCoreModelRouting({
      "core-3": { provider: "minimax", apiModelId: "MiniMax-M2.7" },
    });
    registerModelsDevReasoning([
      {
        providerId: "minimax",
        modelId: "MiniMax-M2.7",
        profile: { reasoning: true, options: [] },
        supportsTemperature: true,
      },
    ]);
    expect(isReasoningCapableModel(CORE_TIER)).toBe(false);
  });

  it("catalog miss falls back to the VENDOR, so a new Core model is not hidden", () => {
    // No registry entry at all — a model live on the vendor's API before models.dev
    // lists it. Keyed on `compass` this answered false; keyed on the vendor it
    // inherits the same legacy answer BYOK has always had.
    routeCoreTierToDeepSeek();
    expect(isReasoningCapableModel(CORE_TIER)).toBe(true);
  });
});

describe("dispatch capability provider", () => {
  it("is identity for every provider except compass", () => {
    expect(
      resolveDispatchCapabilityProviderId(BYOK_SAME_MODEL, "deepseek"),
    ).toBe("deepseek");
    expect(resolveDispatchCapabilityProviderId(CORE_TIER, "openrouter")).toBe(
      "openrouter",
    );
  });

  it("resolves compass to the routed vendor", () => {
    routeCoreTierToDeepSeek();
    expect(resolveDispatchCapabilityProviderId(CORE_TIER, "compass")).toBe(
      "deepseek",
    );
  });

  it("keeps compass when the turn FELL BACK to Core mid-dispatch", () => {
    // `fellBackToCore` rewrites the client but not `effectiveModel`, so the model
    // names a provider that is not answering. Resolving from it would look up the
    // wrong model; `compass` (→ no reasoning) is the honest answer.
    routeCoreTierToDeepSeek();
    const userSelection = {
      name: "gpt-5",
      provider: "openai",
    } as LargeLanguageModel;
    expect(resolveDispatchCapabilityProviderId(userSelection, "compass")).toBe(
      "compass",
    );
  });

  it("lifts a Core tier's ceiling to its vendor's, so Deep ON reaches the real max", () => {
    routeCoreTierToDeepSeek();
    // Under the wire id `compass` this returned "high" — Deep ON asked for one notch
    // below what the model actually offers.
    expect(deriveReasoningCeiling(CORE_TIER, "compass")).toBe("max");
  });
});

describe("what actually goes in the request bucket", () => {
  const settings = (deepThinking: boolean) =>
    ({ deepThinking }) as unknown as UserSettings;

  it("sends the model's own ceiling on Deep ON and one notch below on OFF", () => {
    registerReasoner(); // declares effort values ["high","max"]
    const off = getExtraProviderOptions(
      "deepseek",
      settings(false),
      true,
      32_000,
      "deepseek-v4-pro",
    ) as Record<string, unknown>;
    const on = getExtraProviderOptions(
      "deepseek",
      settings(true),
      true,
      32_000,
      "deepseek-v4-pro",
    ) as Record<string, unknown>;
    expect(off.reasoningEffort).toBe("high");
    expect(on.reasoningEffort).toBe("max");
    // Never the snake_case spelling: the SDK overwrites that key with undefined
    // after spreading the bucket, so it would silently never reach the body.
    expect(off.reasoning_effort).toBeUndefined();
  });

  it("walks the model's OWN values — never a level it did not list", () => {
    registerModelsDevReasoning([
      {
        providerId: "moonshot",
        modelId: "kimi-k3",
        profile: {
          reasoning: true,
          // Note: no "medium". A global ladder would send one it rejects.
          options: [{ type: "effort", values: ["low", "high", "max"] }],
        },
        supportsTemperature: false,
      },
    ]);
    const off = getExtraProviderOptions(
      "moonshot",
      settings(false),
      true,
      32_000,
      "kimi-k3",
    ) as Record<string, unknown>;
    expect(off.reasoningEffort).toBe("high");
  });

  it("a toggle-only model gets a toggle, not an invented budget", () => {
    registerModelsDevReasoning([
      {
        providerId: "minimax",
        modelId: "MiniMax-M3",
        profile: { reasoning: true, options: [{ type: "toggle" }] },
        supportsTemperature: true,
      },
    ]);
    const on = getExtraProviderOptions(
      "minimax",
      settings(true),
      true,
      32_000,
      "MiniMax-M3",
    ) as Record<string, { type?: string }>;
    expect(on.thinking?.type).toBe("enabled");
    expect(on.reasoningEffort).toBeUndefined();
  });

  it("a model that declares no control is sent nothing at all", () => {
    registerModelsDevReasoning([
      {
        providerId: "minimax",
        modelId: "MiniMax-M2.7",
        profile: { reasoning: true, options: [] },
        supportsTemperature: true,
      },
    ]);
    expect(
      getExtraProviderOptions(
        "minimax",
        settings(true),
        true,
        32_000,
        "MiniMax-M2.7",
      ),
    ).toEqual({});
  });
});
