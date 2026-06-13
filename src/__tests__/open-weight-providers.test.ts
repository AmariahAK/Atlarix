import { describe, expect, it } from "vitest";
import {
  CLOUD_PROVIDERS,
  OPENWEIGHT_PROVIDER_BASE_URLS,
  PROVIDER_TO_ENV_VAR,
  PROVIDERS_THAT_SUPPORT_THINKING,
} from "@/ipc/shared/language_model_constants";
import { supportsProviderNativeFetch } from "@/lib/provider_model_fetchers";

const OPEN_WEIGHT_IDS = ["deepseek", "qwen", "minimax", "moonshot"] as const;

describe("open-weight providers (DeepSeek, Qwen, MiniMax, Kimi)", () => {
  it("registers each provider in the cloud catalog with an env var and base URL", () => {
    for (const id of OPEN_WEIGHT_IDS) {
      expect(CLOUD_PROVIDERS[id], `${id} in CLOUD_PROVIDERS`).toBeDefined();
      expect(CLOUD_PROVIDERS[id].displayName).toBeTruthy();
      expect(PROVIDER_TO_ENV_VAR[id], `${id} env var`).toBeTruthy();

      const baseUrl = OPENWEIGHT_PROVIDER_BASE_URLS[id];
      expect(baseUrl, `${id} base URL`).toBeTruthy();
      expect(baseUrl).toMatch(/^https:\/\//);
    }
  });

  it("routes each provider through a native model fetcher", () => {
    for (const id of OPEN_WEIGHT_IDS) {
      expect(supportsProviderNativeFetch(id), `${id} native fetch`).toBe(true);
    }
  });

  it("marks the reasoning-capable providers as thinking-capable", () => {
    expect(PROVIDERS_THAT_SUPPORT_THINKING).toEqual(
      expect.arrayContaining(["deepseek", "qwen", "minimax"]),
    );
  });

  it("points each provider's live /models URL at its real API base", () => {
    // Model lists are sourced dynamically (live /models → models.dev), never
    // hardcoded — so the base URL must be a valid live endpoint.
    expect(OPENWEIGHT_PROVIDER_BASE_URLS.deepseek).toContain("api.deepseek.com");
    expect(OPENWEIGHT_PROVIDER_BASE_URLS.qwen).toContain("dashscope-intl");
    expect(OPENWEIGHT_PROVIDER_BASE_URLS.minimax).toContain("api.minimax.io");
    expect(OPENWEIGHT_PROVIDER_BASE_URLS.moonshot).toContain("api.moonshot.ai");
  });
});
