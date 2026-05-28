import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAtlarixCoreTierCatalog,
  formatModelWithProvider,
  resolveAtlarixCoreIdentity,
} from "@/lib/atlarix-core-catalog";

describe("atlarix-core-catalog", () => {
  beforeEach(() => {
    vi.stubEnv("COMPASS_MODEL_FAST", "deepseek/deepseek-v4-flash");
    vi.stubEnv("COMPASS_MODEL_BALANCED", "deepseek/deepseek-v4-pro");
    vi.stubEnv("COMPASS_MODEL_THINKING", "moonshotai/kimi-k2.6");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds three tier entries with provider slug from model id", () => {
    const catalog = buildAtlarixCoreTierCatalog();
    expect(catalog).toHaveLength(3);
    const balanced = catalog.find((e) => e.slot === "balanced");
    expect(balanced?.openRouterModelId).toBe("deepseek/deepseek-v4-pro");
    expect(balanced?.labelWithProvider).toMatch(/\(deepseek\)/);
    expect(balanced?.providerSlug).toBe("deepseek");
  });

  it("formatModelWithProvider uses lowercase provider slug", () => {
    expect(formatModelWithProvider("DeepSeek V4 Pro", "openrouter")).toBe(
      "DeepSeek V4 Pro (openrouter)",
    );
  });

  it("resolveAtlarixCoreIdentity maps compass-balanced", () => {
    const id = resolveAtlarixCoreIdentity("compass-balanced");
    expect(id.labelWithProvider).toMatch(/\(deepseek\)/);
    expect(id.modelDisplayName).toMatch(/DeepSeek|Pro/i);
  });
});
