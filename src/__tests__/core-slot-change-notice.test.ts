/**
 * When to tell a user the model behind their Core slot changed.
 *
 * THE CASE THAT MOTIVATED THE SHAPE, and the one a tier→model MAP comparison gets
 * wrong: the lineup can hold perfectly still while a user's effective model moves,
 * because their saved slot was substituted or because the new-install default points
 * at a different slot. Comparing the RESOLVED model id — what the turn actually ran
 * on — is the only comparison that catches every route.
 *
 * The silent cases matter as much as the loud one. A fresh install announcing a change
 * it never experienced is worse than saying nothing, and so is a notice that returns
 * on every launch after the user has closed it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron-log", () => ({
  default: { scope: () => ({ info: () => {}, warn: () => {}, log: () => {} }) },
}));
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));

import {
  setCoreModelOverrides,
  __resetCoreModelOverridesForTests,
} from "@/ipc/shared/core-model-override-store";
import {
  computeCoreSlotChange,
  effectiveCoreModelId,
} from "@/lib/routing/core-slot-change";
import { DEFAULT_PAID_CORE_TIER } from "@/ipc/shared/compass_constants";

const GLM = "z-ai/glm-5.3";
const TERRA = "openai/gpt-5.5-terra";
const SOL = "openai/gpt-5.6-sol";
const ASTRA = "openai/gpt-6-astra";

const FULL_LINEUP = {
  "core-1": GLM,
  "core-2": TERRA,
  "core-3": ASTRA,
};

beforeEach(() => setCoreModelOverrides(FULL_LINEUP));
afterEach(() => __resetCoreModelOverridesForTests());

describe("the model a selection actually resolves to", () => {
  it("reads through the slot to the configured model", () => {
    expect(effectiveCoreModelId({ provider: "compass", name: "core-3" })).toBe(
      ASTRA,
    );
  });

  it("follows the same fall-forward the turn uses when a slot is dropped", () => {
    // The whole reason it resolves rather than reads: a selection pointing at a
    // slot the lineup no longer maps must report the model that will really answer.
    setCoreModelOverrides({ "core-1": GLM });
    expect(effectiveCoreModelId({ provider: "compass", name: "core-3" })).toBe(
      GLM,
    );
  });

  it("says nothing for a BYOK user — their model did not change", () => {
    expect(
      effectiveCoreModelId({ provider: "anthropic", name: "claude-opus-5" }),
    ).toBeNull();
  });

  it("tolerates a missing or malformed selection", () => {
    for (const sel of [null, undefined, {}, { provider: "compass" }]) {
      expect(effectiveCoreModelId(sel)).toBeNull();
    }
  });
});

describe("whether to show the notice", () => {
  it("fires when the slot was reassigned under a saved selection", () => {
    // The live case: core-3 went Sol → Astra, roughly a 5x price move, while the
    // user's selection read "core-3" throughout.
    expect(computeCoreSlotChange(SOL, ASTRA)).toEqual({ from: SOL, to: ASTRA });
  });

  it("fires when the default tier moved, which a map comparison would MISS", () => {
    /**
     * This is the case that decided the design. Nothing about the lineup changed
     * here — core-1 is still GLM and core-3 is still Astra — but a user with no
     * saved selection resolves through the new-install default, so moving that
     * default moves them. Comparing the tier→model map sees two identical maps and
     * reports nothing.
     */
    const before = effectiveCoreModelId({
      provider: "compass",
      name: "core-1",
    });
    const after = effectiveCoreModelId({
      provider: "compass",
      name: DEFAULT_PAID_CORE_TIER,
    });
    expect(before).toBe(GLM);
    expect(after).toBe(ASTRA);
    expect(computeCoreSlotChange(before, after)).toEqual({
      from: GLM,
      to: ASTRA,
    });
  });

  it("stays silent with no baseline — a fresh install never experienced a change", () => {
    // Absent must mean "no opinion yet", the same reasoning `appLanguage` records
    // for having no DEFAULT_SETTINGS entry.
    expect(computeCoreSlotChange(undefined, ASTRA)).toBeNull();
    expect(computeCoreSlotChange(null, ASTRA)).toBeNull();
    expect(computeCoreSlotChange("", ASTRA)).toBeNull();
    expect(computeCoreSlotChange("   ", ASTRA)).toBeNull();
  });

  it("stays silent once acknowledged — advancing the baseline IS the dismissal", () => {
    // What makes this fire once instead of every launch.
    expect(computeCoreSlotChange(ASTRA, ASTRA)).toBeNull();
  });

  it("stays silent for a user who is not on Core", () => {
    expect(computeCoreSlotChange(SOL, null)).toBeNull();
  });

  it("fires again for a LATER change, after the first was acknowledged", () => {
    // Why there is no separate dismissed-ids list: a stored dismissal would have to
    // be versioned per change, and a stale one would suppress a notice about a move
    // the user never saw. A baseline cannot go stale — it always names where they are.
    expect(computeCoreSlotChange(ASTRA, ASTRA)).toBeNull();
    expect(computeCoreSlotChange(ASTRA, TERRA)).toEqual({
      from: ASTRA,
      to: TERRA,
    });
  });
});
