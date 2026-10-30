/**
 * The title call's one retry exists to drop `reasoning: "none"` for a model
 * that rejects it. When the first call never sent it, the retry was the same
 * request again: a provider answering 400 got two identical title POSTs
 * (QA capture, ai-26 / ai-ec).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const generateText = vi.fn();
let reasons = false;
let builtin: string | undefined;

vi.mock("ai", () => ({ generateText: (...a: unknown[]) => generateText(...a) }));
vi.mock("@/main/settings", () => ({
  readSettings: () => ({
    selectedModel: { provider: "openai", name: "gpt-x" },
    aiConfiguration: {
      contextSummarization: { summarizationModel: "custom", customSummarizationModel: { provider: "openai", name: "gpt-x" } },
    },
  }),
}));
vi.mock("@/ipc/utils/get_model_client", () => ({
  getModelClient: async () => ({ modelClient: { model: {}, builtinProviderId: builtin }, fellBackToCore: false }),
}));
vi.mock("@/lib/routing/model-reasoning-profile", () => ({
  catalogSaysReasons: () => reasons,
  supportsTemperatureParam: () => true,
}));
vi.mock("@/lib/usage/turn-usage-aggregator", () => ({ recordAuxUsage: () => {} }));
vi.mock("@/lib/summarization_model", () => ({ turnModelForChat: async () => undefined }));

import { generateSessionTitle } from "@/lib/session-title/generate-title";

beforeEach(() => {
  generateText.mockReset();
  builtin = undefined;
});

describe("the title call's retry", () => {
  it("a model that does not reason: a refused call is not sent twice", async () => {
    reasons = false;
    generateText.mockRejectedValueOnce(new Error("400 bad request"));
    expect(await generateSessionTitle("fix the login redirect")).toBeNull();
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("a reasoning model: the retry drops reasoning:none, once", async () => {
    reasons = true;
    generateText
      .mockRejectedValueOnce(new Error("400 reasoning not supported"))
      .mockResolvedValueOnce({ text: "Login redirect fix", usage: {} });
    expect(await generateSessionTitle("fix the login redirect")).toBe("Login redirect fix");
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(generateText.mock.calls[0]![0]).toMatchObject({ reasoning: "none" });
    expect(generateText.mock.calls[1]![0]).not.toHaveProperty("reasoning");
  });

  it("on Atlarix Core the SDK makes no retries: a busy pool gets one title request, not three (live QA 2026-10-30)", async () => {
    reasons = false;
    builtin = "compass";
    generateText.mockResolvedValueOnce({ text: "Login redirect fix", usage: {} });
    await generateSessionTitle("fix the login redirect");
    expect(generateText.mock.calls[0]![0]).toMatchObject({ maxRetries: 0 });
    builtin = "openai";
    generateText.mockResolvedValueOnce({ text: "Login redirect fix", usage: {} });
    await generateSessionTitle("fix the login redirect");
    expect(generateText.mock.calls[1]![0]).not.toHaveProperty("maxRetries");
  });
});
