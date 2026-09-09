/**
 * Edit stats: the counting rules and the model a row is attributed to.
 *
 * The DB rollup itself is exercised end-to-end through the real interceptor in
 * `tests/agent-evals/edit-stats.eval.test.ts` — asserting the pure helpers here and
 * the execution path there is deliberate: this area has a history of tests that
 * proved a tool's envelope while the effect never happened.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  computeLineDelta,
  localDayKey,
  resolveEditStatsModel,
  dispatchedModelIdentity,
} from "@/lib/stats/edit-stats";
import {
  setCoreModelRouting,
  setCoreModelOverrides,
  __resetCoreModelOverridesForTests,
} from "@/ipc/shared/core-model-override-store";
import { editStatsModelLabel } from "@/lib/stats/edit-stats-label";
import type { LargeLanguageModel } from "@/lib/schemas";

beforeEach(() => __resetCoreModelOverridesForTests());
afterEach(() => __resetCoreModelOverridesForTests());

describe("computeLineDelta", () => {
  it("counts a modification as the diff, not the file", () => {
    const before = "a\nb\nc\n";
    const after = "a\nB\nc\n";
    expect(computeLineDelta("update", before, after)).toEqual({
      added: 1,
      removed: 1,
    });
  });

  it("counts a new file as all lines added", () => {
    expect(computeLineDelta("create", undefined, "one\ntwo\nthree\n")).toEqual({
      added: 3,
      removed: 0,
    });
  });

  it("counts a deletion as all lines removed", () => {
    expect(computeLineDelta("delete", "one\ntwo\n", undefined)).toEqual({
      added: 0,
      removed: 2,
    });
  });

  it("counts a rename as nothing — the bytes did not change", () => {
    // Counting it as a delete plus a create would make moving a large file look
    // like the most productive act in the project's history.
    expect(computeLineDelta("rename", "one\ntwo\n", "one\ntwo\n")).toEqual({
      added: 0,
      removed: 0,
    });
  });

  it("does not count a trailing newline as a line", () => {
    expect(computeLineDelta("create", undefined, "only\n").added).toBe(1);
    expect(computeLineDelta("create", undefined, "").added).toBe(0);
  });

  it("counts a pure insertion as added only", () => {
    expect(computeLineDelta("update", "a\nb\n", "a\nnew\nb\n")).toEqual({
      added: 1,
      removed: 0,
    });
  });
});

describe("localDayKey", () => {
  it("uses the LOCAL calendar day, not UTC", () => {
    // 22:30 local on the 5th. Under UTC this could be the 6th (or the 4th),
    // which would file an evening's work under the wrong day for most of the
    // world — on a column whose whole purpose is to read as "today".
    const evening = new Date(2026, 7, 5, 22, 30, 0);
    expect(localDayKey(evening)).toBe("2026-08-05");
  });

  it("zero-pads so the key sorts lexically", () => {
    expect(localDayKey(new Date(2026, 0, 9))).toBe("2026-01-09");
  });
});

describe("resolveEditStatsModel", () => {
  const coreTier = {
    name: "core-3",
    provider: "compass",
  } as LargeLanguageModel;

  it("stores a Core turn as the RESOLVED model, never the tier id", () => {
    // Storing `core-3` would relabel history the next time the lineup moves:
    // last month's DeepSeek lines would start claiming to be its replacement.
    setCoreModelOverrides({ "core-3": "deepseek/deepseek-v4-pro" });
    expect(resolveEditStatsModel(coreTier)).toEqual({
      provider: "compass",
      name: "deepseek/deepseek-v4-pro",
    });
  });

  it("keeps provider `compass`, which is what separates Core from BYOK", () => {
    setCoreModelRouting({
      "core-3": { provider: "deepseek", apiModelId: "deepseek-v4-pro" },
    });
    setCoreModelOverrides({ "core-3": "deepseek/deepseek-v4-pro" });
    const core = resolveEditStatsModel(coreTier);
    const byok = resolveEditStatsModel({
      name: "deepseek-v4-pro",
      provider: "deepseek",
    } as LargeLanguageModel);
    // Same underlying model, two routes — and the rows must not collapse together.
    expect(core?.provider).toBe("compass");
    expect(byok?.provider).toBe("deepseek");
  });

  it("passes BYOK through untouched", () => {
    expect(
      resolveEditStatsModel({
        name: "claude-sonnet-5",
        provider: "anthropic",
      } as LargeLanguageModel),
    ).toEqual({ provider: "anthropic", name: "claude-sonnet-5" });
  });

  it("falls back to the tier id rather than dropping an unmapped tier", () => {
    expect(resolveEditStatsModel(coreTier)).toEqual({
      provider: "compass",
      name: "core-3",
    });
  });

  it("returns null when there is no model to attribute to", () => {
    expect(resolveEditStatsModel(undefined)).toBeNull();
    expect(
      resolveEditStatsModel({ name: "", provider: "" } as LargeLanguageModel),
    ).toBeNull();
  });
});

describe("editStatsModelLabel", () => {
  it("names Core as Core, not as the vendor underneath it", () => {
    // The picker's own label for a Core model already carries the VENDOR slug, so
    // without this branch a Core row and a BYOK row would read identically — and
    // telling those apart is the reason `provider` is stored at all.
    expect(
      editStatsModelLabel({
        provider: "compass",
        modelId: "deepseek/deepseek-v4-pro",
      }),
    ).toBe("DeepSeek V4 Pro (Atlarix Core)");
  });

  it("names a BYOK model by its provider", () => {
    expect(
      editStatsModelLabel({ provider: "deepseek", modelId: "deepseek-v4-pro" }),
    ).toBe("DeepSeek V4 Pro (deepseek)");
  });

  it("distinguishes the SAME model reached two ways", () => {
    const core = editStatsModelLabel({
      provider: "compass",
      modelId: "deepseek/deepseek-v4-pro",
    });
    const byok = editStatsModelLabel({
      provider: "deepseek",
      modelId: "deepseek-v4-pro",
    });
    expect(core).not.toBe(byok);
  });
});

describe("attribution follows what DISPATCHED, not what was selected", () => {
  it("credits Atlarix Core when a keyless selection fell back to it", () => {
    // The live case, found in the owner's logs: a BYOK model is selected, the
    // provider has no usable key, `getModelClient` quietly re-points the turn at
    // Core and rewrites the model INTERNALLY — `effectiveModel` still says
    // deepseek. Reading the selection would file Core's work under the user's own
    // key, which is the one distinction this card exists to draw.
    const selected = {
      name: "deepseek-v4-pro",
      provider: "deepseek",
    } as LargeLanguageModel;
    const row = resolveEditStatsModel(selected, {
      providerId: "compass",
      modelId: "deepseek/deepseek-v4-pro",
    });
    expect(row).toEqual({
      provider: "compass",
      name: "deepseek/deepseek-v4-pro",
    });
  });

  it("agrees with the selection when no fallback happened", () => {
    const selected = {
      name: "deepseek-v4-pro",
      provider: "deepseek",
    } as LargeLanguageModel;
    expect(
      resolveEditStatsModel(selected, {
        providerId: "deepseek",
        modelId: "deepseek-v4-pro",
      }),
    ).toEqual({ provider: "deepseek", name: "deepseek-v4-pro" });
  });

  it("falls back to the selection when the client says nothing useful", () => {
    const selected = {
      name: "claude-sonnet-5",
      provider: "anthropic",
    } as LargeLanguageModel;
    expect(resolveEditStatsModel(selected, {})).toEqual({
      provider: "anthropic",
      name: "claude-sonnet-5",
    });
    expect(resolveEditStatsModel(selected, null)).toEqual({
      provider: "anthropic",
      name: "claude-sonnet-5",
    });
  });

  it("reads the wire id off a model client", () => {
    expect(
      dispatchedModelIdentity({
        builtinProviderId: "compass",
        model: { modelId: "deepseek/deepseek-v4-pro" },
      }),
    ).toEqual({ providerId: "compass", modelId: "deepseek/deepseek-v4-pro" });
  });

  it("reports nothing rather than guessing when the client has no model id", () => {
    // A local runtime (LM Studio) sets no builtinProviderId; the selection path
    // must take over rather than a half-filled identity being recorded.
    expect(dispatchedModelIdentity({ model: undefined })).toEqual({
      providerId: undefined,
      modelId: undefined,
    });
  });
});
