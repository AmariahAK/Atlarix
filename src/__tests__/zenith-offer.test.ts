/**
 * Auto's top rung failed too (`X-Atlarix-Ladder: top`): the turn's error offers
 * Atlarix Zenith, once per chat, only when Zenith is offered at all.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { __resetZenithOfferForTests, noteLadderTop, takeZenithOffer } from "@/lib/core/zenith-offer";
import { __resetCoreModelOverridesForTests, setCoreZenith } from "@/ipc/shared/core-model-override-store";
import { ZENITH_OFFER_LINE, coreRateLimitedMessage } from "@/shared/billing_copy";
import { errorNotice } from "@/cli/tui/limits";

const top = new Headers({ "x-atlarix-ladder": "top" });

beforeEach(() => {
  __resetZenithOfferForTests();
  __resetCoreModelOverridesForTests();
  setCoreZenith({ id: "atlarix/zenith", label: "Atlarix Zenith" });
});

describe("the Zenith offer", () => {
  it("is made once per chat, after the proxy says the top rung failed", () => {
    noteLadderTop(5, top);
    expect(takeZenithOffer(5)).toBe(true);
    noteLadderTop(5, top);
    expect(takeZenithOffer(5)).toBe(false);
    noteLadderTop(6, top);
    expect(takeZenithOffer(6)).toBe(true);
  });

  it("is never made without the header, or when Zenith is not offered", () => {
    noteLadderTop(5, new Headers());
    expect(takeZenithOffer(5)).toBe(false);
    setCoreZenith(null);
    noteLadderTop(7, top);
    expect(takeZenithOffer(7)).toBe(false);
  });

  it("the terminal keeps the failure's own notice and adds the way to Zenith", () => {
    const n = errorNotice(`${coreRateLimitedMessage(30)} ${ZENITH_OFFER_LINE}`);
    expect(n.title).toBe("This model is busy");
    expect(n.actions).toMatch(/\/model Atlarix Zenith$/);
    expect(n.detail).toMatch(/higher cost/);
  });
});
