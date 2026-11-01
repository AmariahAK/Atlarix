/**
 * "Your monthly Atlarix Core usage is used up" is for an account that HAS a
 * monthly allowance and spent it. It showed at every launch for credit-only
 * accounts that never had one (QA 2026-10-30, A21).
 */
import { describe, expect, it } from "vitest";
import { allowanceNudgeStep } from "@/hooks/useCreditBalance";

describe("the allowance-used-up nudge", () => {
  it("never fires for an account with no allowance (pay-as-you-go only)", () => {
    expect(allowanceNudgeStep({ grantedCents: 0, grantedTotalCents: 0, purchasedCents: 701 })).toBe("none");
    expect(allowanceNudgeStep({ grantedCents: 0, grantedTotalCents: null, purchasedCents: 701 })).toBe("none");
  });

  it("fires once an allowance is spent and bought credit remains", () => {
    expect(allowanceNudgeStep({ grantedCents: 0, grantedTotalCents: 1000, purchasedCents: 500 })).toBe("nudge");
  });

  it("re-arms while the allowance lasts, and stays quiet with nothing left at all", () => {
    expect(allowanceNudgeStep({ grantedCents: 300, grantedTotalCents: 1000, purchasedCents: 500 })).toBe("rearm");
    expect(allowanceNudgeStep({ grantedCents: 0, grantedTotalCents: 1000, purchasedCents: 0 })).toBe("none");
    expect(allowanceNudgeStep({ grantedCents: null, grantedTotalCents: 1000, purchasedCents: 500 })).toBe("none");
  });
});
