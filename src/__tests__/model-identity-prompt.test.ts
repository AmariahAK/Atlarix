import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildWorkstationIdentityBlock,
  formatModelApiNameForDisplay,
  providerBrandName,
  resolveActiveModelIdentity,
} from "@/lib/model-identity-prompt";
import { constructSystemPromptParts } from "@/prompts/system_prompt";

describe("model-identity-prompt", () => {
  beforeEach(() => {
    vi.stubEnv("ATLARIX_CORE_MODEL_1", "deepseek/deepseek-v4-flash");
    vi.stubEnv("ATLARIX_CORE_MODEL_2", "deepseek/deepseek-v4-pro");
    vi.stubEnv("ATLARIX_CORE_MODEL_3", "moonshotai/kimi-k2.6");
    vi.stubEnv("ATLARIX_CORE_MODEL_4", "anthropic/claude-opus-4");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("formats DeepSeek-style api names for display", () => {
    expect(formatModelApiNameForDisplay("deepseek/deepseek-v3")).toContain("DeepSeek");
  });

  it("maps provider ids to brand names", () => {
    expect(providerBrandName("anthropic")).toBe("Anthropic");
    expect(providerBrandName("openrouter")).toBe("OpenRouter");
  });

  it("builds workstation block with separate NorahLabs and Atlarix links", () => {
    const block = buildWorkstationIdentityBlock({
      modelDisplayName: "DeepSeek V4 Pro",
      providerBrand: "deepseek",
      labelWithProvider: "DeepSeek V4 Pro (deepseek)",
      appVersion: "8.7.0",
    });
    expect(block).toMatch(/agent workstation/i);
    expect(block).toMatch(/norahlabs\.com/);
    expect(block).toMatch(/atlarix\.dev/);
    expect(block).toMatch(/DeepSeek V4 Pro \(deepseek\)/);
    expect(block).not.toMatch(/You are \*\*Atlarix AI\*\*/);
    expect(block).not.toMatch(/You are \*\*Compass/i);
  });

  it("maps Core tier to routed model identity (legacy id included)", () => {
    const id = resolveActiveModelIdentity({
      provider: "compass",
      name: "core-2",
    });
    expect(id.providerBrand).toBe("deepseek");
    expect(id.labelWithProvider).toMatch(/\(deepseek\)/);
    expect(id.modelDisplayName).toMatch(/DeepSeek|Pro/i);
    expect(id.modelDisplayName).not.toMatch(/Compass/i);

    const legacy = resolveActiveModelIdentity({
      provider: "compass",
      name: "compass-balanced",
    });
    expect(legacy.labelWithProvider).toBe(id.labelWithProvider);
  });

  it("resolveActiveModelIdentity uses routed model", () => {
    const id = resolveActiveModelIdentity({
      provider: "anthropic",
      name: "claude-sonnet-4-20250514",
    });
    expect(id.providerBrand).toBe("anthropic");
    expect(id.modelDisplayName.length).toBeGreaterThan(0);
  });

  it("constructSystemPromptParts includes workstation identity when activeModel set", () => {
    const { stableHeader } = constructSystemPromptParts({
      activeModel: { provider: "anthropic", name: "claude-sonnet-4" },
    });
    expect(stableHeader).toMatch(/running inside \*\*Atlarix\*\*/);
    expect(stableHeader).not.toMatch(/in-app assistant for \*\*Atlarix\*\*/);
  });
});
