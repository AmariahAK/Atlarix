import { describe, expect, it } from "vitest";
import { UPGRADE_LINE } from "./upgrade-line";
import { UPGRADE_LINE as DESKTOP_LINE } from "../../../../src/shared/billing_copy";

describe("the upgrade line", () => {
  it("is word for word the desktop's", () => {
    expect(UPGRADE_LINE).toBe(DESKTOP_LINE);
  });
});
