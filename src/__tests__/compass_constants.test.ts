import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPASS_TIER_FAST,
  getCompassMasterApiKey,
  getOpenRouterModelIdForCompassTier,
  isCompassBuildConfigured,
} from "@/ipc/shared/compass_constants";

describe("compass_constants build env", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads COMPASS_OPENROUTER_API_KEY from process.env", () => {
    vi.stubEnv("COMPASS_OPENROUTER_API_KEY", " sk-test-key ");
    expect(getCompassMasterApiKey()).toBe("sk-test-key");
    expect(isCompassBuildConfigured()).toBe(true);
  });

  it("returns undefined when the master key is missing or blank", () => {
    vi.stubEnv("COMPASS_OPENROUTER_API_KEY", "   ");
    expect(getCompassMasterApiKey()).toBeUndefined();
    expect(isCompassBuildConfigured()).toBe(false);
  });

  it("maps compass tiers to static COMPASS_MODEL_* env vars", () => {
    vi.stubEnv("COMPASS_MODEL_FAST", "deepseek/deepseek-v3.2");
    vi.stubEnv("COMPASS_MODEL_BALANCED", "moonshotai/kimi-k2");
    vi.stubEnv("COMPASS_MODEL_THINKING", "anthropic/claude-sonnet-4");

    expect(getOpenRouterModelIdForCompassTier(COMPASS_TIER_FAST)).toBe(
      "deepseek/deepseek-v3.2",
    );
    expect(getOpenRouterModelIdForCompassTier("compass-unknown")).toBeUndefined();
  });
});
