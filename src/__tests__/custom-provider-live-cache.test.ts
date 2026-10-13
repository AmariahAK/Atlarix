/**
 * fd292b6a review (CLI/editor implementer): getLanguageModels runs several
 * times per turn through findLanguageModel, so a provider you added must not
 * be asked for /models each time — and a dead one must not cost its wait each
 * time. The live list is cached per provider, address and key (failures too),
 * and findLanguageModel looks in what's stored first.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { fetchCustomProviderModels } = vi.hoisted(() => ({
  fetchCustomProviderModels: vi.fn(async () => [
    { apiName: "qwen2.5:3b", displayName: "qwen2.5:3b", description: "", type: "cloud" as const },
  ]),
}));
vi.mock("@/lib/provider_model_fetchers", () => ({ fetchCustomProviderModels }));

import { liveCustomModels } from "@/ipc/shared/language_model_helpers";

beforeEach(() => fetchCustomProviderModels.mockClear());

describe("a provider's live model list", () => {
  it("is fetched once for calls in a row", async () => {
    const t = 1_000_000;
    await liveCustomModels("custom::cache-a", "http://127.0.0.1:11434/v1", undefined, t);
    await liveCustomModels("custom::cache-a", "http://127.0.0.1:11434/v1", undefined, t + 5_000);
    expect(fetchCustomProviderModels).toHaveBeenCalledTimes(1);
  });

  it("a failure is cached too", async () => {
    fetchCustomProviderModels.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const t = 2_000_000;
    expect(await liveCustomModels("custom::cache-b", "http://dead:1/v1", "k", t)).toEqual([]);
    expect(await liveCustomModels("custom::cache-b", "http://dead:1/v1", "k", t + 1_000)).toEqual([]);
    expect(fetchCustomProviderModels).toHaveBeenCalledTimes(1);
  });

  it("is asked again after a minute, or with another key or address", async () => {
    const t = 3_000_000;
    await liveCustomModels("custom::cache-c", "http://a/v1", "k1", t);
    await liveCustomModels("custom::cache-c", "http://a/v1", "k2", t + 1);
    await liveCustomModels("custom::cache-c", "http://b/v1", "k2", t + 2);
    await liveCustomModels("custom::cache-c", "http://b/v1", "k2", t + 61_000);
    expect(fetchCustomProviderModels).toHaveBeenCalledTimes(4);
  });
});
