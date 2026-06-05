import { describe, expect, it } from "vitest";
import { subscriptionTierToPlan } from "@/lib/compass-plan-access";

/**
 * v11: plan-based model gating was removed — every plan gets all Core models,
 * metered by the shared token pool. Only the tier→plan label mapping remains.
 */
describe("compass-plan-access", () => {
  it("maps Supabase tier strings to plans", () => {
    expect(subscriptionTierToPlan("pro")).toBe("pro");
    expect(subscriptionTierToPlan("PRO")).toBe("pro");
    expect(subscriptionTierToPlan("workforce")).toBe("workforce");
    expect(subscriptionTierToPlan("free")).toBe("free");
    expect(subscriptionTierToPlan(undefined)).toBe("free");
    expect(subscriptionTierToPlan(null)).toBe("free");
    expect(subscriptionTierToPlan("unknown-tier")).toBe("free");
  });
});
