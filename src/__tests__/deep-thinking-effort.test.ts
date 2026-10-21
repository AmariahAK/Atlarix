/**
 * Deep thinking with no level chosen asks for the top of the model's list.
 *
 * `atlarix run --deep-thinking` (and a settings file from before /effort, which
 * has the switch but no level) sent adaptive Claude thinking with NO `effort`,
 * so the API's default applied, not `max` (seen on the wire 2026-10-19). The
 * editors already showed the top level as current for that state; the request
 * now says the same.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { chosenEffortFor } from "@/ipc/utils/thinking_utils";
import {
  __resetReasoningRegistryForTests,
  registerModelsDevReasoning,
} from "@/lib/routing/model-reasoning-profile";
import { buildReasoningProviderOptions, detectReasoningCapability } from "@/lib/routing/reasoning-detector";
import type { UserSettings } from "@/lib/schemas";

const settings = (s: { deepThinking?: boolean; effort?: string }) => s as unknown as UserSettings;

describe("deep thinking with no level", () => {
  beforeEach(() => {
    __resetReasoningRegistryForTests();
    registerModelsDevReasoning([
      {
        providerId: "anthropic",
        modelId: "claude-sonnet-5-5",
        profile: { reasoning: true, options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }] },
        supportsTemperature: false,
      },
      {
        providerId: "anthropic",
        modelId: "claude-haiku-4-5-20251001",
        profile: { reasoning: true, options: [{ type: "budget_tokens" }] },
        supportsTemperature: true,
      },
    ] as never);
  });

  it("sends max on adaptive Claude", () => {
    const chosen = chosenEffortFor(settings({ deepThinking: true }), "anthropic", "claude-sonnet-5-5");
    expect(chosen?.level).toBe("max");
    const cap = detectReasoningCapability("claude-sonnet-5-5", "anthropic");
    expect(buildReasoningProviderOptions(cap, true, "max", 64_000, chosen?.level).anthropic).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      effort: "max",
    });
  });

  it("a chosen level still wins", () => {
    expect(chosenEffortFor(settings({ deepThinking: true, effort: "low" }), "anthropic", "claude-sonnet-5-5")?.level).toBe(
      "low",
    );
  });

  it("nothing chosen and the switch off: the model's own default", () => {
    expect(chosenEffortFor(settings({}), "anthropic", "claude-sonnet-5-5")).toBeNull();
  });

  it("a budget model keeps its deep-thinking budget path", () => {
    expect(chosenEffortFor(settings({ deepThinking: true }), "anthropic", "claude-haiku-4-5-20251001")).toBeNull();
  });
});
