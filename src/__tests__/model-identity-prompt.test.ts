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
    vi.stubEnv("COMPASS_MODEL_FAST", "deepseek/deepseek-v4-flash");
    vi.stubEnv("COMPASS_MODEL_BALANCED", "deepseek/deepseek-v4-pro");
    vi.stubEnv("COMPASS_MODEL_THINKING", "moonshotai/kimi-k2.6");
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
      providerBrand: "openrouter",
      labelWithProvider: "DeepSeek V4 Pro (openrouter)",
      appVersion: "8.6.4",
    });
    expect(block).toMatch(/agent workstation/i);
    expect(block).toMatch(/norahlabs\.com/);
    expect(block).toMatch(/atlarix\.dev/);
    expect(block).toMatch(/DeepSeek V4 Pro \(openrouter\)/);
    expect(block).not.toMatch(/You are \*\*Atlarix AI\*\*/);
    expect(block).not.toMatch(/You are \*\*Compass/i);
  });

  it("maps compass tier to OpenRouter model identity", () => {
    const id = resolveActiveModelIdentity({
      provider: "compass",
      name: "compass-balanced",
    });
    expect(id.providerBrand).toBe("openrouter");
    expect(id.labelWithProvider).toMatch(/openrouter\)/);
    expect(id.modelDisplayName).toMatch(/DeepSeek|Pro/i);
    expect(id.modelDisplayName).not.toMatch(/Compass/i);
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
