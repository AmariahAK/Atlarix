/**
 * Regression: `getEffectiveBudget(provider, chatId)` must reflect the model's
 * real context window resolved by `getContextWindowDetailed`, not a
 * per-provider hardcoded ceiling.
 *
 * Two angles guarded here:
 *   1. Compass (synthetic provider): live TTFT capture > 200K fallback > catalog leak.
 *   2. Every other provider (openai/anthropic/openrouter/...): dynamic per-model
 *      resolution via the live registry (`findLanguageModel`) with the shared
 *      memoization layer — no hardcoded 128K/200K/1M tables anywhere in the
 *      effective-budget path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/main/settings", () => ({
  readSettings: vi.fn(),
}));

vi.mock("../ipc/utils/findLanguageModel", () => ({
  findLanguageModel: vi.fn(),
}));

vi.mock("@/lib/context/token-counter", () => ({
  exactTokenCountText: (s: string) => Math.ceil((s ?? "").length / 4),
  exactTokenCount: () => 0,
}));

import {
  getEffectiveBudget,
  setCompassContextWindow,
  clearCompassContextWindow,
} from "../ipc/utils/token_utils";
import { readSettings } from "@/main/settings";
import { findLanguageModel } from "../ipc/utils/findLanguageModel";

const mockReadSettings = vi.mocked(readSettings);
const mockFindLanguageModel = vi.mocked(findLanguageModel);

describe("getEffectiveBudget — Compass awareness", () => {
  const TEST_CHAT_ID = 42;

  beforeEach(() => {
    vi.clearAllMocks();
    clearCompassContextWindow(TEST_CHAT_ID);
    mockReadSettings.mockReturnValue({
      selectedModel: { name: "compass-fast", provider: "compass" },
      tokenBudgetOverrides: {},
    } as any);
    // Catalog value (post-fix: 200_000). Test should still pass if a future
    // catalog change keeps it at any positive number — we assert the compass-aware
    // path takes precedence over this.
    mockFindLanguageModel.mockResolvedValue({
      apiName: "compass-fast",
      contextWindow: 200_000,
    } as any);
  });

  afterEach(() => {
    clearCompassContextWindow(TEST_CHAT_ID);
  });

  it("returns the compass-fallback (200_000) when no TTFT has been observed for the chat", async () => {
    const { budget, source } = await getEffectiveBudget("compass", TEST_CHAT_ID);
    expect(budget).toBe(200_000);
    expect(source).toBe("model");
  });

  it("returns the live per-chat value captured at TTFT (e.g. 1M) instead of the catalog limit", async () => {
    setCompassContextWindow(TEST_CHAT_ID, 1_000_000);
    const { budget, source } = await getEffectiveBudget("compass", TEST_CHAT_ID);
    expect(budget).toBe(1_000_000);
    expect(source).toBe("model");
  });

  it("honours a user override over the compass-aware path", async () => {
    mockReadSettings.mockReturnValue({
      selectedModel: { name: "compass-fast", provider: "compass" },
      tokenBudgetOverrides: { compass: 64_000 },
    } as any);
    setCompassContextWindow(TEST_CHAT_ID, 1_000_000);
    const { budget, source } = await getEffectiveBudget("compass", TEST_CHAT_ID);
    expect(budget).toBe(64_000);
    expect(source).toBe("override");
  });

  it("falls back to the compass-fallback when chatId is not supplied", async () => {
    // Pre-existing callers (compaction.ts) pass providerId only. The compass
    // branch should still resolve to the safer 200K fallback rather than the
    // legacy 128K catalog leak.
    const { budget, source } = await getEffectiveBudget("compass");
    expect(budget).toBe(200_000);
    expect(source).toBe("model");
  });
});

describe("getEffectiveBudget — dynamic resolution for non-compass providers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["openai", "gpt-4o-test", 128_000],
    ["anthropic", "claude-sonnet-4-test", 200_000],
    ["google", "gemini-1.5-pro-test", 1_000_000],
    ["openrouter", "qwen/qwen3-flash-test", 1_048_576],
    ["groq", "llama-3.3-70b-test", 128_000],
    // Smaller, unusual contexts must propagate verbatim — proves no
    // hardcoded ceiling clamps them.
    ["mistral", "mistral-small-test", 32_768],
    ["xai", "grok-2-test", 131_072],
  ])(
    "resolves %s/%s to the live registry value (%d) — no provider-specific hardcoding",
    async (provider, name, contextWindow) => {
      mockReadSettings.mockReturnValue({
        selectedModel: { name, provider },
        tokenBudgetOverrides: {},
      } as any);
      mockFindLanguageModel.mockResolvedValue({
        apiName: name,
        contextWindow,
      } as any);
      const { budget, source } = await getEffectiveBudget(provider);
      expect(budget).toBe(contextWindow);
      expect(source).toBe("model");
    },
  );

  it("honours a user override for any provider before consulting the registry", async () => {
    mockReadSettings.mockReturnValue({
      selectedModel: { name: "gpt-4o-override-test", provider: "openai" },
      tokenBudgetOverrides: { openai: 32_000 },
    } as any);
    mockFindLanguageModel.mockResolvedValue({
      apiName: "gpt-4o-override-test",
      contextWindow: 128_000,
    } as any);
    const { budget, source } = await getEffectiveBudget("openai");
    expect(budget).toBe(32_000);
    expect(source).toBe("override");
    // Registry must NOT be called when an override decides the budget —
    // overrides are the cheap path.
    expect(mockFindLanguageModel).not.toHaveBeenCalled();
  });

  it("falls back to DEFAULT_CONTEXT_WINDOW (200_000) when the registry has no value", async () => {
    mockReadSettings.mockReturnValue({
      // Use an exotic model name so the per-model memo from a prior test
      // can't pollute this one (memo key is `provider:name:customModelId`).
      selectedModel: { name: "unknown-model-xyz-test", provider: "openai" },
      tokenBudgetOverrides: {},
    } as any);
    mockFindLanguageModel.mockResolvedValue(undefined as any);
    const { budget, source } = await getEffectiveBudget("openai");
    expect(budget).toBe(200_000);
    expect(source).toBe("model");
  });
});
