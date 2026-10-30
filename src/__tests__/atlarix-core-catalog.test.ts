import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAtlarixCoreTierCatalog,
  coreTierPresentationFromModel,
  formatModelWithProvider,
  resolveAtlarixCoreIdentity,
} from "@/lib/atlarix-core-catalog";

describe("atlarix-core-catalog", () => {
  beforeEach(() => {
    vi.stubEnv("ATLARIX_CORE_MODEL_1", "deepseek/deepseek-v4-flash");
    vi.stubEnv("ATLARIX_CORE_MODEL_2", "deepseek/deepseek-v4-pro");
    vi.stubEnv("ATLARIX_CORE_MODEL_3", "moonshotai/kimi-k2.6");
    vi.stubEnv("ATLARIX_CORE_MODEL_4", "anthropic/claude-opus-4");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds four Core entries with provider slug from model id", () => {
    const catalog = buildAtlarixCoreTierCatalog();
    expect(catalog).toHaveLength(4);
    const core2 = catalog.find((e) => e.internalTierId === "core-2");
    expect(core2?.coreModelId).toBe("deepseek/deepseek-v4-pro");
    // A Core model is named alone (QA C1); the vendor stays on providerSlug.
    expect(core2?.labelWithProvider).toBe(core2?.modelDisplayName);
    expect(core2?.providerSlug).toBe("deepseek");
    const core4 = catalog.find((e) => e.internalTierId === "core-4");
    expect(core4?.coreModelId).toBe("anthropic/claude-opus-4");
  });

  it("coreTierPresentationFromModel parses a synthetic Core model into a presentation", () => {
    const p = coreTierPresentationFromModel({
      apiName: "core-1",
      displayName: "Kimi K2.7 Code (moonshotai)",
    });
    expect(p.internalTierId).toBe("core-1");
    expect(p.modelDisplayName).toBe("Kimi K2.7 Code");
    expect(p.providerSlug).toBe("moonshotai");
    expect(p.labelWithProvider).toBe("Kimi K2.7 Code (moonshotai)");
  });

  it("coreTierPresentationFromModel tolerates a name with no provider suffix", () => {
    const p = coreTierPresentationFromModel({
      apiName: "core-2",
      displayName: "Core 2",
    });
    expect(p.internalTierId).toBe("core-2");
    expect(p.labelWithProvider).toBe("Core 2");
    // Core is direct; a vendor-less name is Atlarix's own, never "openrouter".
    expect(p.providerSlug).toBe("atlarix");
  });

  it("formatModelWithProvider uses lowercase provider slug", () => {
    expect(formatModelWithProvider("DeepSeek V4 Pro", "openrouter")).toBe(
      "DeepSeek V4 Pro (openrouter)",
    );
  });

  it("resolveAtlarixCoreIdentity maps core ids and legacy compass ids", () => {
    const id = resolveAtlarixCoreIdentity("core-2");
    expect(id.labelWithProvider).toBe(id.modelDisplayName);
    expect(id.modelDisplayName).toMatch(/DeepSeek|Pro/i);

    // Legacy persisted selection keeps resolving to the same entry.
    const legacy = resolveAtlarixCoreIdentity("compass-balanced");
    expect(legacy.labelWithProvider).toBe(id.labelWithProvider);
  });
});

describe("model ids with no catalog name still read as names (Usage page + reply labels, 2026-10-30)", () => {
  it("drops Bedrock's region and vendor prefix and version stamps, and keeps real versions", async () => {
    const { formatModelApiNameForDisplay: f, formatModelWithProvider: w } = await import("@/lib/format-openrouter-model-label");
    expect(f("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("Claude Haiku 4.5");
    expect(f("zai.glm-4.7-flash")).toBe("GLM 4.7 Flash");
    expect(f("z-ai/glm-5.3-flash")).toBe("GLM 5.3 Flash");
    expect(f("qwen.qwen3-coder-30b-a3b-v1:0")).toBe("Qwen3 Coder 30b A3b");
    expect(f("claude-sonnet-4-6")).toBe("Claude Sonnet 4.6");
    expect(f("openai/gpt-4.1")).toBe("GPT-4.1");
    expect(f("gpt-6.1-terra")).toBe("GPT-6.1 Terra");
    expect(w("Claude Haiku 4.5", "custom::bedrock-qa")).toBe("Claude Haiku 4.5 (bedrock-qa)");
  });
});
