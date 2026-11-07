/**
 * Each row of the terminal's (and the editors') model list knows its provider
 * as people know it: "OpenRouter · 128K context", not "OpenRouter (BYOK) · …".
 * The group keeps the provider's listed name.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/ipc/shared/language_model_helpers", () => ({
  getLanguageModelProviders: async () => [
    { id: "compass", name: "Atlarix Core", type: "cloud" },
    { id: "openrouter", name: "OpenRouter (BYOK)", type: "cloud" },
    { id: "custom::work", name: "Work (EU)", type: "custom" },
    { id: "atlarix-cli-dev-ee0d96d8", name: "Your endpoint (127.0.0.1:8080)", type: "custom" },
    { id: "ollama", name: "Ollama", type: "local" },
  ],
  getLanguageModelsByProviders: async () => ({
    compass: [{ apiName: "core-auto", displayName: "Atlarix Auto", description: "Picks for you", contextWindow: 128_000 }],
    openrouter: [{ apiName: "qwen/qwen3", displayName: "Qwen3", contextWindow: 128_000 }],
    "custom::work": [{ apiName: "m", displayName: "M", contextWindow: 32_000 }],
    "atlarix-cli-dev-ee0d96d8": [{ apiName: "fake-model", displayName: "fake-model" }],
    ollama: [{ apiName: "qwen2.5:3b", displayName: "qwen2.5:3b" }],
  }),
}));
vi.mock("@/main/settings", () => ({ readSettings: () => ({}) }));
vi.mock("@/ipc/utils/token_utils", () => ({ getContextWindow: async () => 128_000 }));
vi.mock("@/cli/agent/services", () => ({ realServices: { account: { kind: async () => "free" } } }));

import { loadModelOptions } from "@/cli/agent/models";

describe("the model list's provider labels", () => {
  it("strips the catalog's bracket from the row, not from the group", async () => {
    const rows = await loadModelOptions();
    const by = (provider: string) => rows.find((o) => o.provider === provider)!;
    expect(by("openrouter")).toMatchObject({ providerName: "OpenRouter (BYOK)", providerLabel: "OpenRouter", detail: "OpenRouter · 128K context" });
    expect(by("custom::work")).toMatchObject({ providerLabel: "Work (EU)", detail: "Work (EU) · 32K context" });
    expect(by("atlarix-cli-dev-ee0d96d8")).toMatchObject({ providerLabel: "Your endpoint (127.0.0.1:8080)" });
    expect(by("ollama")).toMatchObject({ providerLabel: "Ollama" });
    expect(by("compass").providerLabel).toBeUndefined();
    expect(by("compass").detail).toBe("Picks for you · 128K context");
  });
});
