import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CORE_TIER_1,
  CORE_TIER_2,
  CORE_TIER_3,
  CORE_TIER_4,
  CORE_TIER_ORDER,
  getCompassMasterApiKey,
  getOpenRouterModelIdForCoreTier,
  isCompassBuildConfigured,
  isCoreTierId,
  normalizeCoreTierId,
  __setDevCoreKeyProvider,
} from "@/ipc/shared/compass_constants";

const NOOP_DEV_PROVIDER = {
  apiKey: () => undefined,
  modelId: () => undefined,
};

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

  it("exposes four Core slots", () => {
    expect(CORE_TIER_ORDER).toEqual(["core-1", "core-2", "core-3", "core-4"]);
  });

  it("maps Core tiers to static ATLARIX_CORE_MODEL_* env vars", () => {
    vi.stubEnv("ATLARIX_CORE_MODEL_1", "deepseek/deepseek-v3.2");
    vi.stubEnv("ATLARIX_CORE_MODEL_2", "moonshotai/kimi-k2");
    vi.stubEnv("ATLARIX_CORE_MODEL_3", "anthropic/claude-sonnet-4");
    vi.stubEnv("ATLARIX_CORE_MODEL_4", "anthropic/claude-opus-4");

    expect(getOpenRouterModelIdForCoreTier(CORE_TIER_1)).toBe(
      "deepseek/deepseek-v3.2",
    );
    expect(getOpenRouterModelIdForCoreTier(CORE_TIER_2)).toBe(
      "moonshotai/kimi-k2",
    );
    expect(getOpenRouterModelIdForCoreTier(CORE_TIER_3)).toBe(
      "anthropic/claude-sonnet-4",
    );
    expect(getOpenRouterModelIdForCoreTier(CORE_TIER_4)).toBe(
      "anthropic/claude-opus-4",
    );
    expect(getOpenRouterModelIdForCoreTier("core-unknown")).toBeUndefined();
  });

  it("resolves legacy compass-* ids through the alias map forever", () => {
    vi.stubEnv("ATLARIX_CORE_MODEL_1", "deepseek/deepseek-v3.2");
    vi.stubEnv("ATLARIX_CORE_MODEL_2", "moonshotai/kimi-k2");
    vi.stubEnv("ATLARIX_CORE_MODEL_3", "anthropic/claude-sonnet-4");

    expect(normalizeCoreTierId("compass-fast")).toBe(CORE_TIER_1);
    expect(normalizeCoreTierId("compass-balanced")).toBe(CORE_TIER_2);
    expect(normalizeCoreTierId("compass-thinking")).toBe(CORE_TIER_3);
    expect(normalizeCoreTierId("core-4")).toBe(CORE_TIER_4);

    expect(getOpenRouterModelIdForCoreTier("compass-fast")).toBe(
      "deepseek/deepseek-v3.2",
    );
    expect(getOpenRouterModelIdForCoreTier("compass-thinking")).toBe(
      "anthropic/claude-sonnet-4",
    );

    expect(isCoreTierId("compass-balanced")).toBe(true);
    expect(isCoreTierId("core-2")).toBe(true);
    expect(isCoreTierId("gpt-4o")).toBe(false);
  });
});

describe("compass_constants dev-key fallback (Bug 3)", () => {
  // CI embeds COMPASS_OPENROUTER_API_KEY / ATLARIX_CORE_MODEL_* as real secrets,
  // so without clearing them the dev-provider fallback never runs (the ambient
  // build-time value wins) and a masked '***' secret leaks into an assertion.
  // Clear all of them first; each test re-stubs what it needs.
  beforeEach(() => {
    vi.stubEnv("COMPASS_OPENROUTER_API_KEY", "");
    vi.stubEnv("ATLARIX_CORE_MODEL_1", "");
    vi.stubEnv("ATLARIX_CORE_MODEL_2", "");
    vi.stubEnv("ATLARIX_CORE_MODEL_3", "");
    vi.stubEnv("ATLARIX_CORE_MODEL_4", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    __setDevCoreKeyProvider(NOOP_DEV_PROVIDER); // reset to release no-op
  });

  it("uses the injected dev key when no build-time key is embedded", () => {
    __setDevCoreKeyProvider({
      apiKey: () => "sk-dev",
      modelId: (t) => (t === CORE_TIER_1 ? "deepseek/x" : undefined),
    });
    expect(getCompassMasterApiKey()).toBe("sk-dev");
    expect(isCompassBuildConfigured()).toBe(true);
    expect(getOpenRouterModelIdForCoreTier(CORE_TIER_1)).toBe("deepseek/x");
  });

  it("build-time embedded key wins over the dev provider", () => {
    vi.stubEnv("COMPASS_OPENROUTER_API_KEY", "sk-ci");
    __setDevCoreKeyProvider({
      apiKey: () => "sk-dev",
      modelId: () => "dev/model",
    });
    expect(getCompassMasterApiKey()).toBe("sk-ci");
  });

  it("default no-op provider keeps release behavior (no dev key)", () => {
    vi.stubEnv("COMPASS_OPENROUTER_API_KEY", "");
    __setDevCoreKeyProvider(NOOP_DEV_PROVIDER);
    expect(getCompassMasterApiKey()).toBeUndefined();
    expect(isCompassBuildConfigured()).toBe(false);
  });
});
