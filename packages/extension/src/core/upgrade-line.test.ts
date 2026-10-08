import { describe, expect, it } from "vitest";
import { CREDIT_FIRST_LINE } from "./upgrade-line";
import { CREDIT_FIRST_LINE as DESKTOP_LINE } from "../../../../src/shared/billing_copy";

describe("the upgrade line", () => {
  it("is word for word the desktop's", () => {
    expect(CREDIT_FIRST_LINE).toBe(DESKTOP_LINE);
  });

  it("leads with credit, not the subscription", () => {
    expect(CREDIT_FIRST_LINE.indexOf("credit")).toBeLessThan(CREDIT_FIRST_LINE.indexOf("Pro"));
    expect(CREDIT_FIRST_LINE).toContain("$10");
  });
});
