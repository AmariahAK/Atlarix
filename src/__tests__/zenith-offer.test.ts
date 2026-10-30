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

describe("the offer at the end of a turn that answered (ai-34: the header comes on a 200)", () => {
  it("the turn's end carries it once, and never on the user's stop", async () => {
    const { safeSend } = await import("@/ipc/utils/safe_sender");
    const sent: unknown[] = [];
    const sender = { isDestroyed: () => false, send: (_c: string, p: unknown) => sent.push(p) } as never;
    noteLadderTop(9, top);
    safeSend(sender, "chat:response:end", { chatId: 9, userCancelled: true, updatedFiles: false });
    safeSend(sender, "chat:response:end", { chatId: 9, updatedFiles: false });
    safeSend(sender, "chat:response:end", { chatId: 9, updatedFiles: false });
    expect(sent.map((p) => (p as { zenithOffer?: boolean }).zenithOffer)).toEqual([undefined, true, undefined]);
  });

  it("ACP editors (Zed, the VS Code panel) get it as a finished step, in words that fit them", async () => {
    const { diffUpdates } = await import("@/cli/acp/updates");
    const text = `◇ ${ZENITH_OFFER_LINE.replace("Pick it in the model list", "/model Atlarix Zenith")}`;
    const out = diffUpdates([{ kind: "notice", id: "12:turn-notice0", level: "info", text }] as never, new Map());
    expect(out).toEqual([
      expect.objectContaining({ sessionUpdate: "tool_call", status: "completed", title: ZENITH_OFFER_LINE }),
    ]);
  });
});
