/**
 * Forced `tool_choice` on a wake turn vs. models that think by default.
 *
 * THE BUG (v14.17.x, confirmed from production logs): a turn that parked on a
 * background job died with "Core has an issue" every time. The wake turn forces
 * `tool_choice: collect_results` so a weak model cannot skip the delivery, and
 * DeepSeek answered:
 *
 *   400 {"error":{"message":"Thinking mode does not support this tool_choice"}}
 *
 * The guard meant to prevent exactly this read `enableNativeReasoning` — the USER's
 * Deep-thinking toggle. deepseek-v4-pro reasons by DEFAULT, so with Deep OFF the
 * guard said "not thinking, safe to force" while the provider was thinking anyway.
 * The signal has to be the model's own declared nature, not what we asked for.
 *
 * Two layers are covered here, because the catalog can be stale or missing a row:
 *   1. the capability gate (don't force at a model that reasons), and
 *   2. the classifier behind the fallback (any provider's refusal is recoverable).
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetReasoningRegistryForTests,
  catalogSaysReasons,
  registerModelsDevReasoning,
} from "@/lib/routing/model-reasoning-profile";
import { isForcedToolChoiceRejection } from "@/ipc/handlers/chat_stream/network-retry";

/** The real models.dev rows for the current Core lineup. */
const CATALOG = [
  {
    providerId: "deepseek",
    modelId: "deepseek-v4-pro",
    profile: {
      reasoning: true,
      options: [{ type: "toggle" }, { type: "effort", values: ["high", "max"] }],
    },
    supportsTemperature: true,
  },
  {
    providerId: "zai",
    modelId: "glm-5.2",
    profile: { reasoning: true, options: [{ type: "toggle" }] },
    supportsTemperature: true,
  },
  {
    providerId: "openai",
    modelId: "gpt-4o-mini",
    profile: { reasoning: false, options: [] },
    supportsTemperature: true,
  },
];

/**
 * The production decision, mirrored from chat_stream_handlers.ts. Kept as a local
 * helper because the real call site sits mid-way through a 2,000-line IPC handler
 * that cannot be invoked in a unit test — the LOGIC is what regressed, and it is
 * reproduced here exactly.
 */
function shouldForceCollect(args: {
  wakeHasPendingResults: boolean;
  enableNativeReasoning: boolean;
  providerId: string;
  modelId: string;
}): boolean {
  const modelReasonsNatively =
    catalogSaysReasons(args.providerId, args.modelId) ?? true;
  return (
    args.wakeHasPendingResults &&
    !args.enableNativeReasoning &&
    !modelReasonsNatively
  );
}

describe("forced collect_results gate", () => {
  beforeEach(() => {
    __resetReasoningRegistryForTests();
    registerModelsDevReasoning(CATALOG);
  });

  it("does NOT force a forced tool_choice at DeepSeek with Deep-thinking OFF", () => {
    // The exact production configuration that failed. Deep OFF, so the old guard
    // (`!enableNativeReasoning`) evaluated true and forced the choice.
    expect(
      shouldForceCollect({
        wakeHasPendingResults: true,
        enableNativeReasoning: false,
        providerId: "deepseek",
        modelId: "deepseek-v4-pro",
      }),
    ).toBe(false);
  });

  it("does not force at GLM either — it also reasons by default", () => {
    expect(
      shouldForceCollect({
        wakeHasPendingResults: true,
        enableNativeReasoning: false,
        providerId: "zai",
        modelId: "glm-5.2",
      }),
    ).toBe(false);
  });

  it("still forces at a genuinely non-reasoning model (the weak-model guarantee)", () => {
    // The forced path exists so a weak model cannot skip delivery. Narrowing the
    // gate must not delete that behaviour where it is both safe and useful.
    expect(
      shouldForceCollect({
        wakeHasPendingResults: true,
        enableNativeReasoning: false,
        providerId: "openai",
        modelId: "gpt-4o-mini",
      }),
    ).toBe(true);
  });

  it("treats an unknown model as reasoning-capable and does not force", () => {
    // Catalog-miss convention: unknown → permissive. A model newer than the last
    // catalog refresh must not be assumed safe to force.
    expect(
      shouldForceCollect({
        wakeHasPendingResults: true,
        enableNativeReasoning: false,
        providerId: "somevendor",
        modelId: "brand-new-model",
      }),
    ).toBe(false);
  });

  it("never forces when there is nothing pending to collect", () => {
    expect(
      shouldForceCollect({
        wakeHasPendingResults: false,
        enableNativeReasoning: false,
        providerId: "openai",
        modelId: "gpt-4o-mini",
      }),
    ).toBe(false);
  });
});

describe("isForcedToolChoiceRejection", () => {
  /** Verbatim from the production log that identified this bug. */
  const DEEPSEEK_LIVE = Object.assign(
    new Error("Thinking mode does not support this tool_choice"),
    {
      name: "AI_APICallError",
      statusCode: 400,
      responseBody: JSON.stringify({
        error: {
          message: "Thinking mode does not support this tool_choice",
          type: "invalid_request_error",
          code: "invalid_request_error",
        },
      }),
    },
  );

  it("recognises the live DeepSeek rejection", () => {
    expect(isForcedToolChoiceRejection(DEEPSEEK_LIVE)).toBe(true);
  });

  it("recognises other vendors' phrasings — it keys on the parameter, not the prose", () => {
    // The point of the fallback is to survive a provider we have never met, so the
    // matcher must not encode any single vendor's wording.
    const anthropic = Object.assign(
      new Error("tool_choice: {\"type\":\"tool\"} is not supported when thinking is enabled"),
      { statusCode: 400 },
    );
    const alibaba = Object.assign(
      new Error("tool_choice is not supported in thinking mode"),
      { statusCode: 400 },
    );
    const spaced = Object.assign(new Error("Invalid `tool choice` parameter"), {
      statusCode: 422,
    });
    expect(isForcedToolChoiceRejection(anthropic)).toBe(true);
    expect(isForcedToolChoiceRejection(alibaba)).toBe(true);
    expect(isForcedToolChoiceRejection(spaced)).toBe(true);
  });

  it("finds the reason in a nested error body, not just the top-level message", () => {
    expect(
      isForcedToolChoiceRejection({
        statusCode: 400,
        error: { message: "Bad Request", responseBody: '{"msg":"bad tool_choice"}' },
      }),
    ).toBe(true);
  });

  it("ignores unrelated 4xx errors", () => {
    const contextLength = Object.assign(
      new Error("This model's maximum context length is 128000 tokens"),
      { statusCode: 400 },
    );
    expect(isForcedToolChoiceRejection(contextLength)).toBe(false);
    expect(isForcedToolChoiceRejection(null)).toBe(false);
    expect(isForcedToolChoiceRejection(undefined)).toBe(false);
  });

  it("ignores a 5xx that happens to mention tool_choice", () => {
    // An upstream fault is not a request we can fix by dropping a parameter;
    // routing it into the fallback would mask a real outage as a schema problem.
    const upstream = Object.assign(new Error("upstream error near tool_choice"), {
      statusCode: 503,
    });
    expect(isForcedToolChoiceRejection(upstream)).toBe(false);
  });
});
