import { describe, expect, it } from "vitest";
import {
  coerceCompassModelForPlan,
  filterCompassModelsForPlan,
} from "@/lib/compass-plan-access";
import type { LanguageModel } from "@/ipc/ipc_types";
import {
  COMPASS_TIER_BALANCED,
  COMPASS_TIER_FAST,
  COMPASS_TIER_THINKING,
} from "@/ipc/shared/compass_constants";

const models = [
  { apiName: COMPASS_TIER_FAST, displayName: "A", type: "cloud" },
  { apiName: COMPASS_TIER_BALANCED, displayName: "B", type: "cloud" },
  { apiName: COMPASS_TIER_THINKING, displayName: "C", type: "cloud" },
] as unknown as LanguageModel[];

describe("compass-plan-access", () => {
  it("filters to one model for free plan", () => {
    const out = filterCompassModelsForPlan(models, "free");
    expect(out).toHaveLength(1);
    expect(out[0]?.apiName).toBe(COMPASS_TIER_FAST);
  });

  it("allows all three for pro and workforce", () => {
    expect(filterCompassModelsForPlan(models, "pro")).toHaveLength(3);
    expect(filterCompassModelsForPlan(models, "workforce")).toHaveLength(3);
  });

  it("coerces balanced to fast for free on send", () => {
    expect(coerceCompassModelForPlan(COMPASS_TIER_BALANCED, "free")).toBe(
      COMPASS_TIER_FAST,
    );
    expect(coerceCompassModelForPlan(COMPASS_TIER_BALANCED, "pro")).toBe(
      COMPASS_TIER_BALANCED,
    );
  });
});
