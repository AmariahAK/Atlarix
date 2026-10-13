/**
 * findLanguageModel runs several times per turn: a model already in the
 * stored list is found there, with no call to a provider's endpoint; only a
 * provider you added, missing the model, is asked live.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { getLanguageModels } = vi.hoisted(() => ({
  getLanguageModels: vi.fn(async (arg?: { providerId: string; live?: boolean }) =>
    arg?.live === false
      ? [{ apiName: "typed-model", displayName: "t", description: "", type: "custom" as const, id: 1 }]
      : [
          { apiName: "typed-model", displayName: "t", description: "", type: "custom" as const, id: 1 },
          { apiName: "live-model", displayName: "l", description: "", type: "cloud" as const },
        ],
  ),
}));
vi.mock("@/ipc/shared/language_model_helpers", () => ({ getLanguageModels }));

import { findLanguageModel } from "@/ipc/utils/findLanguageModel";

beforeEach(() => getLanguageModels.mockClear());
const calls = () => getLanguageModels.mock.calls.map(([a]) => a).filter((a) => a?.providerId);

describe("finding the model a turn runs on", () => {
  it("a stored model is found without asking the endpoint", async () => {
    const m = await findLanguageModel({ provider: "custom::x", name: "typed-model" } as never);
    expect(m?.apiName).toBe("typed-model");
    expect(calls().map((a) => a!.live)).toEqual([false]);
  });

  it("a provider you added is asked live only when the model isn't stored", async () => {
    const m = await findLanguageModel({ provider: "custom::x", name: "live-model" } as never);
    expect(m?.apiName).toBe("live-model");
    expect(calls()).toHaveLength(2);
  });

  it("a built-in provider is not listed twice on a miss", async () => {
    await findLanguageModel({ provider: "openai", name: "nope" } as never);
    expect(calls()).toHaveLength(1);
  });
});
