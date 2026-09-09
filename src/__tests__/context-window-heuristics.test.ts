import { afterEach, describe, expect, it, vi } from "vitest";
import type { LargeLanguageModel, UserSettings } from "@/lib/schemas";

vi.mock("@/ipc/utils/findLanguageModel", () => ({
  findLanguageModel: vi.fn(),
}));

const modelsDev = vi.hoisted(() => ({
  getModelsDevLimits: vi.fn(
    async () => null as { context?: number; output?: number } | null,
  ),
}));
vi.mock("@/lib/models_dev", () => modelsDev);

import {
  heuristicRawContextLength,
  resolveModelContextLimit,
  GENERIC_CONTEXT_FALLBACK,
} from "@/lib/context/resolve-model-context-limit";
import {
  warmOpenRouterModelCache,
  getCachedOpenRouterModelRow,
} from "@/lib/routing/tier-context-limits";
import { findLanguageModel } from "@/ipc/utils/findLanguageModel";
import {
  setCoreModelRouting,
  __resetCoreModelOverridesForTests,
} from "@/ipc/shared/core-model-override-store";

const model = (provider: string, name: string): LargeLanguageModel =>
  ({ provider, name }) as LargeLanguageModel;

const noSettings = {} as UserSettings;

// W12 (v14.8.11): the per-model-name hint table was DELETED — limits come from
// provider APIs / OpenRouter catalog / models.dev; the only constants left are
// one generic logged fallback and local-runtime placeholders.
describe("heuristicRawContextLength — generic last resort only", () => {
  it("no name-sniffing: every cloud model gets the single generic fallback", () => {
    expect(
      heuristicRawContextLength(
        model("openrouter", "deepseek/deepseek-v4-pro"),
      ),
    ).toBe(GENERIC_CONTEXT_FALLBACK);
    expect(
      heuristicRawContextLength(model("anthropic", "claude-something-new")),
    ).toBe(GENERIC_CONTEXT_FALLBACK);
    expect(
      heuristicRawContextLength(model("openrouter", "some/brand-new-model")),
    ).toBe(GENERIC_CONTEXT_FALLBACK);
  });

  it("keeps conservative local-runtime placeholders (real window fetched async)", () => {
    expect(heuristicRawContextLength(model("ollama", "llama3"))).toBe(8192);
    expect(heuristicRawContextLength(model("lmstudio", "any"))).toBe(16384);
  });
});

describe("resolveModelContextLimit — provider-uniform resolution (W12)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(findLanguageModel).mockReset();
    modelsDev.getModelsDevLimits.mockReset();
    modelsDev.getModelsDevLimits.mockResolvedValue(null);
    // Core routing is module-level state; leaking it across cases would make the
    // non-Core assertions depend on test order.
    __resetCoreModelOverridesForTests();
  });

  it("user override wins over every source (incl. compaction denominator)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    vi.mocked(findLanguageModel).mockResolvedValue({
      apiName: "claude-x",
      contextWindow: 268_000,
    } as never);
    const res = await resolveModelContextLimit(model("anthropic", "claude-x"), {
      tokenBudgetOverrides: { anthropic: 555_000 },
    } as unknown as UserSettings);
    expect(res).toEqual({ tierLimit: 555_000, rawContextLength: 555_000 });
  });

  it("uses the provider-API context window when available", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    vi.mocked(findLanguageModel).mockResolvedValue({
      apiName: "claude-x",
      contextWindow: 268_000,
    } as never);
    const res = await resolveModelContextLimit(
      model("anthropic", "claude-x"),
      noSettings,
    );
    expect(res.rawContextLength).toBe(268_000);
    expect(res.tierLimit).toBe(Math.max(4096, Math.floor(268_000 * 0.8)));
  });

  it("native provider with no API window resolves via models.dev (the DeepSeek 1M fix)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    vi.mocked(findLanguageModel).mockResolvedValue({
      apiName: "deepseek-v4-pro",
    } as never);
    modelsDev.getModelsDevLimits.mockResolvedValue({
      context: 1_048_576,
      output: 384_000,
    });
    const res = await resolveModelContextLimit(
      model("deepseek", "deepseek-v4-pro"),
      noSettings,
    );
    expect(res.rawContextLength).toBe(1_048_576);
    expect(res.tierLimit).toBe(Math.floor(1_048_576 * 0.8));
  });

  /**
   * THE CORE CONTEXT FIX. Core resolved its window through the OpenRouter catalog,
   * keyed by a `vendor/model` wire id. A directly-routed tier matches nothing there,
   * so Core fell through to the 128K generic fallback — compacting a 1M-token model
   * at about an eighth of its real window. models.dev is now consulted FIRST for
   * `compass`, keyed by the tier's provider + vendor model id.
   */
  it("Core resolves its real ~1M window from models.dev, not the 128K fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    // No OpenRouter row and no per-model row: exactly the post-cutover situation.
    vi.mocked(findLanguageModel).mockResolvedValue(undefined as never);
    modelsDev.getModelsDevLimits.mockResolvedValue({
      context: 1_000_000,
      output: 384_000,
    });
    setCoreModelRouting({
      "core-3": { provider: "deepseek", apiModelId: "deepseek-v4-pro" },
    });

    const res = await resolveModelContextLimit(
      model("compass", "core-3"),
      noSettings,
    );

    expect(res.rawContextLength).toBe(1_000_000);
    // Budget = 0.8 safety factor; compaction fires at 0.75 of that (~600K).
    expect(res.tierLimit).toBe(800_000);
    expect(res.tierLimit).toBeGreaterThan(GENERIC_CONTEXT_FALLBACK * 6);
    // Keyed by the VENDOR id, never the synthetic `compass`.
    expect(modelsDev.getModelsDevLimits).toHaveBeenCalledWith(
      "deepseek",
      "deepseek-v4-pro",
    );
  });

  it("Core falls back gracefully when models.dev has no row for the tier", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    vi.mocked(findLanguageModel).mockResolvedValue(undefined as never);
    modelsDev.getModelsDevLimits.mockResolvedValue(null);
    setCoreModelRouting({
      "core-3": { provider: "deepseek", apiModelId: "deepseek-v4-pro" },
    });
    const res = await resolveModelContextLimit(
      model("compass", "core-3"),
      noSettings,
    );
    expect(res.rawContextLength).toBe(GENERIC_CONTEXT_FALLBACK);
  });

  it("falls back to the single generic constant when every source misses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    vi.mocked(findLanguageModel).mockResolvedValue(undefined as never);
    const res = await resolveModelContextLimit(
      model("anthropic", "some-unlisted-model"),
      noSettings,
    );
    expect(res.rawContextLength).toBe(GENERIC_CONTEXT_FALLBACK);
  });
});

describe("warmOpenRouterModelCache — fetch-failure tolerance", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never throws and caches no rows when the fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down"))),
    );
    await expect(warmOpenRouterModelCache()).resolves.toBeUndefined();
    // No catalog row → resolveModelContextLimit falls through to later steps.
    expect(
      getCachedOpenRouterModelRow("anthropic/claude-3.5-sonnet"),
    ).toBeUndefined();
  });
});
