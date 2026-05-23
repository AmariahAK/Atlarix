import { describe, expect, it } from "vitest";
import {
  autoModelIdsMatchProvider,
  buildAutoSettingsForProvider,
  getDefaultAutoSettingsPatchSync,
} from "@/lib/routing/auto-settings-defaults-ui";
import {
  COMPASS_TIER_BALANCED,
  COMPASS_TIER_FAST,
  COMPASS_TIER_THINKING,
} from "@/ipc/shared/compass_constants";
import type { UserSettings } from "@/lib/schemas";
import { hasAutoRoutingModelConfig } from "@/ipc/utils/get_model_client";

const baseSettings = (): UserSettings =>
  ({
    selectedModel: { provider: "openai", name: "gpt-4o" },
    providerSettings: {},
    autoModelRouting: true,
    autoProviderId: null,
    autoModelIds: undefined,
    selectedTemplateId: "default",
  }) as UserSettings;

describe("auto-settings-defaults-ui", () => {
  it("builds compass tier triple", () => {
    const patch = buildAutoSettingsForProvider("compass", baseSettings());
    expect(patch.autoModelIds?.length).toBe(3);
    expect(patch.autoProviderId).toBe("compass");
  });

  it("getDefaultAutoSettingsPatchSync enables routing config when compass available", () => {
    const patch = getDefaultAutoSettingsPatchSync(baseSettings(), {
      compassAvailable: true,
      configuredProviderIds: [],
    });
    expect(patch?.autoProviderId).toBe("compass");
    const merged = { ...baseSettings(), ...patch };
    expect(hasAutoRoutingModelConfig(merged)).toBe(true);
  });

  it("reselects compass tiers when switching back from openrouter model ids", () => {
    const stale = {
      ...baseSettings(),
      autoProviderId: "compass",
      autoModelIds: ["openai/gpt-4o", "anthropic/claude-3", "google/gemini"] as [
        string,
        string,
        string,
      ],
    };
    expect(autoModelIdsMatchProvider("compass", stale.autoModelIds)).toBe(false);
    const patch = buildAutoSettingsForProvider("compass", stale);
    expect(patch.autoModelIds).toEqual([
      COMPASS_TIER_FAST,
      COMPASS_TIER_BALANCED,
      COMPASS_TIER_THINKING,
    ]);
  });

  it("returns null when no provider credentials", () => {
    const patch = getDefaultAutoSettingsPatchSync(baseSettings(), {
      compassAvailable: false,
      configuredProviderIds: [],
    });
    expect(patch).toBeNull();
  });
});
