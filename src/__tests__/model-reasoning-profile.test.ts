/**
 * Per-model reasoning resolution.
 *
 * The bug this replaces: reasoning params were chosen by a PROVIDER allowlist, so
 * every model of a listed provider got the same Anthropic/Google-shaped
 * `thinking.budget_tokens` block. MiniMax-M3 declares a toggle and no budget channel,
 * so its reasoning was never actually being controlled — while MiniMax-M2.7 (which
 * declares no control at all and reasons natively) looked fine, because the wrong
 * block was simply ignored. Same provider, opposite symptoms.
 *
 * Profiles below are the REAL models.dev rows for the four Core models.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetReasoningRegistryForTests,
  catalogSaysReasons,
  hasMeaningfulReasoningControl,
  normalizedEffortValues,
  registerModelsDevReasoning,
  resolveReasoningRequest,
  supportsTemperatureParam,
} from "@/lib/routing/model-reasoning-profile";

const CATALOG = [
  {
    providerId: "minimax",
    modelId: "MiniMax-M3",
    profile: { reasoning: true, options: [{ type: "toggle" }] },
    supportsTemperature: true,
  },
  {
    providerId: "minimax",
    modelId: "MiniMax-M2.7",
    // reasoning: true, NO declared control — reasons natively.
    profile: { reasoning: true, options: [] },
    supportsTemperature: true,
  },
  {
    providerId: "deepseek",
    modelId: "deepseek-v4-pro",
    profile: {
      reasoning: true,
      options: [
        { type: "toggle" },
        { type: "effort", values: ["high", "max"] },
      ],
    },
    supportsTemperature: true,
  },
  {
    providerId: "deepseek",
    modelId: "deepseek-chat",
    profile: { reasoning: false, options: [] },
    supportsTemperature: true,
  },
  {
    providerId: "moonshot",
    modelId: "kimi-k3",
    profile: {
      reasoning: true,
      options: [
        { type: "toggle" },
        { type: "effort", values: ["low", "high", "max"] },
      ],
    },
    // The live row: kimi-k3 does NOT accept a temperature parameter.
    supportsTemperature: false,
  },
  {
    providerId: "qwen",
    modelId: "qwen3.7-max",
    profile: {
      reasoning: true,
      options: [{ type: "toggle" }, { type: "budget_tokens" }],
    },
    supportsTemperature: true,
  },
];

beforeEach(() => {
  __resetReasoningRegistryForTests();
  registerModelsDevReasoning(CATALOG);
});

describe("normalizedEffortValues", () => {
  it("orders and dedupes declared values", () => {
    expect(
      normalizedEffortValues([
        { type: "effort", values: ["max", "low", "high"] },
      ]),
    ).toEqual(["low", "high", "max"]);
  });

  it("maps provider 'xhigh' onto max", () => {
    expect(
      normalizedEffortValues([{ type: "effort", values: ["xhigh"] }]),
    ).toEqual(["max"]);
  });

  it("drops values outside the canonical ladder", () => {
    expect(
      normalizedEffortValues([{ type: "effort", values: ["turbo", "high"] }]),
    ).toEqual(["high"]);
  });

  it("is empty when there is no effort channel", () => {
    expect(normalizedEffortValues([{ type: "toggle" }])).toEqual([]);
    expect(normalizedEffortValues([])).toEqual([]);
  });
});

describe("resolveReasoningRequest — toggle-only (the MiniMax-M3 case)", () => {
  it("sends a TOGGLE, never a level or a budget", () => {
    const on = resolveReasoningRequest({
      providerId: "minimax",
      modelId: "MiniMax-M3",
      deepThinking: true,
    });
    expect(on).toEqual({ kind: "toggle", enabled: true });

    const off = resolveReasoningRequest({
      providerId: "minimax",
      modelId: "MiniMax-M3",
      deepThinking: false,
    });
    expect(off).toEqual({ kind: "toggle", enabled: false });
  });

  it("never yields an effort or budget kind for a toggle-only model", () => {
    for (const deepThinking of [true, false]) {
      const req = resolveReasoningRequest({
        providerId: "minimax",
        modelId: "MiniMax-M3",
        deepThinking,
      });
      expect(req.kind).not.toBe("effort");
      expect(req.kind).not.toBe("budget");
    }
  });

  it("resolves the same model case-insensitively", () => {
    // The wire id is lowercase (`minimax/minimax-m3`) while the catalog is not.
    expect(
      resolveReasoningRequest({
        providerId: "minimax",
        modelId: "minimax-m3",
        deepThinking: true,
      }),
    ).toEqual({ kind: "toggle", enabled: true });
  });
});

describe("resolveReasoningRequest — effort channel", () => {
  it("Deep ON asks for the model's TRUE max", () => {
    expect(
      resolveReasoningRequest({
        providerId: "deepseek",
        modelId: "deepseek-v4-pro",
        deepThinking: true,
      }),
    ).toEqual({ kind: "effort", effort: "max" });
  });

  it("Deep OFF sits one step below, within the model's OWN values", () => {
    expect(
      resolveReasoningRequest({
        providerId: "deepseek",
        modelId: "deepseek-v4-pro",
        deepThinking: false,
      }),
    ).toEqual({ kind: "effort", effort: "high" });
  });

  it("skips a level the model does not list", () => {
    // kimi-k3 lists ["low","high","max"] — no "medium". A global ladder would send
    // "medium" for Deep OFF, a value the model would reject.
    const off = resolveReasoningRequest({
      providerId: "moonshot",
      modelId: "kimi-k3",
      deepThinking: false,
    });
    expect(off).toEqual({ kind: "effort", effort: "high" });
  });

  it("never emits a value outside the model's declared set", () => {
    for (const [providerId, modelId, allowed] of [
      ["deepseek", "deepseek-v4-pro", ["high", "max"]],
      ["moonshot", "kimi-k3", ["low", "high", "max"]],
    ] as const) {
      for (const deepThinking of [true, false]) {
        const req = resolveReasoningRequest({
          providerId,
          modelId,
          deepThinking,
        });
        if (req.kind !== "effort")
          throw new Error("expected an effort request");
        expect(allowed).toContain(req.effort);
      }
    }
  });

  it("clamps to the single value when only one is declared", () => {
    registerModelsDevReasoning([
      {
        providerId: "x",
        modelId: "one-level",
        profile: {
          reasoning: true,
          options: [{ type: "effort", values: ["high"] }],
        },
        supportsTemperature: true,
      },
    ]);
    for (const deepThinking of [true, false]) {
      expect(
        resolveReasoningRequest({
          providerId: "x",
          modelId: "one-level",
          deepThinking,
        }),
      ).toEqual({ kind: "effort", effort: "high" });
    }
  });

  it("prefers the effort channel over an accompanying toggle", () => {
    // deepseek-v4-pro declares BOTH; effort is strictly more expressive.
    expect(
      resolveReasoningRequest({
        providerId: "deepseek",
        modelId: "deepseek-v4-pro",
        deepThinking: true,
      }).kind,
    ).toBe("effort");
  });
});

describe("resolveReasoningRequest — budget channel", () => {
  it("maps the toggle onto a max/high budget hint", () => {
    expect(
      resolveReasoningRequest({
        providerId: "qwen",
        modelId: "qwen3.7-max",
        deepThinking: true,
      }),
    ).toEqual({ kind: "budget", effortHint: "max" });
    expect(
      resolveReasoningRequest({
        providerId: "qwen",
        modelId: "qwen3.7-max",
        deepThinking: false,
      }),
    ).toEqual({ kind: "budget", effortHint: "high" });
  });
});

describe("resolveReasoningRequest — nothing to send", () => {
  it("sends NOTHING for a non-reasoning model", () => {
    expect(
      resolveReasoningRequest({
        providerId: "deepseek",
        modelId: "deepseek-chat",
        deepThinking: true,
      }),
    ).toEqual({ kind: "none" });
  });

  it("sends NOTHING for a model that reasons natively with no control", () => {
    // MiniMax-M2.7. It reasons on its own; a parameter can only do harm — and this
    // is why the old wrong block appeared harmless here.
    expect(
      resolveReasoningRequest({
        providerId: "minimax",
        modelId: "MiniMax-M2.7",
        deepThinking: true,
      }),
    ).toEqual({ kind: "none" });
  });

  it("reports UNKNOWN for a model absent from the catalog", () => {
    // The caller keeps its legacy provider heuristic — treating unknown as
    // no-reasoning would downgrade any model newer than the last catalog refresh.
    expect(
      resolveReasoningRequest({
        providerId: "deepseek",
        modelId: "deepseek-v9-unreleased",
        deepThinking: true,
      }),
    ).toEqual({ kind: "unknown" });
  });
});

describe("temperature gate", () => {
  it("refuses temperature for kimi-k3, which does not accept it", () => {
    expect(supportsTemperatureParam("moonshot", "kimi-k3")).toBe(false);
  });

  it("allows it for models that do", () => {
    expect(supportsTemperatureParam("deepseek", "deepseek-v4-pro")).toBe(true);
    expect(supportsTemperatureParam("minimax", "MiniMax-M3")).toBe(true);
  });

  it("defaults to ALLOWED for an unknown model", () => {
    // Permissive on a catalog miss, matching the convention used elsewhere.
    expect(supportsTemperatureParam("deepseek", "brand-new")).toBe(true);
    expect(supportsTemperatureParam(undefined, "")).toBe(true);
  });

  it("resolves case-insensitively and via the bare id", () => {
    expect(supportsTemperatureParam("moonshot", "KIMI-K3")).toBe(false);
    expect(supportsTemperatureParam(undefined, "kimi-k3")).toBe(false);
  });
});

describe("UI gating helpers", () => {
  it("reports whether the catalog says a model reasons", () => {
    expect(catalogSaysReasons("deepseek", "deepseek-v4-pro")).toBe(true);
    expect(catalogSaysReasons("deepseek", "deepseek-chat")).toBe(false);
    expect(catalogSaysReasons("deepseek", "unknown-model")).toBeUndefined();
  });

  it("hides the Deep toggle where it would do nothing", () => {
    // Reasons natively but exposes no control — a toggle would be a lie.
    expect(hasMeaningfulReasoningControl("minimax", "MiniMax-M2.7")).toBe(
      false,
    );
    expect(hasMeaningfulReasoningControl("deepseek", "deepseek-chat")).toBe(
      false,
    );
  });

  it("shows it where there is a real control", () => {
    expect(hasMeaningfulReasoningControl("minimax", "MiniMax-M3")).toBe(true);
    expect(hasMeaningfulReasoningControl("deepseek", "deepseek-v4-pro")).toBe(
      true,
    );
    expect(hasMeaningfulReasoningControl("qwen", "qwen3.7-max")).toBe(true);
  });
});

describe("registry scoping", () => {
  it("does not let one provider's row clobber another's", () => {
    registerModelsDevReasoning([
      {
        providerId: "provider-a",
        modelId: "shared-name",
        profile: { reasoning: true, options: [{ type: "toggle" }] },
        supportsTemperature: true,
      },
      {
        providerId: "provider-b",
        modelId: "shared-name",
        profile: { reasoning: false, options: [] },
        supportsTemperature: false,
      },
    ]);
    expect(
      resolveReasoningRequest({
        providerId: "provider-a",
        modelId: "shared-name",
        deepThinking: true,
      }),
    ).toEqual({ kind: "toggle", enabled: true });
    expect(
      resolveReasoningRequest({
        providerId: "provider-b",
        modelId: "shared-name",
        deepThinking: true,
      }),
    ).toEqual({ kind: "none" });
  });
});
