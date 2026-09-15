/**
 * The always-ask set, which a site grant must never unlock.
 *
 * Two failure modes are being balanced here, and the tests name both:
 *   - MISSING one is a password typed into a page nobody agreed to.
 *   - FIRING on ordinary things is worse than having no gate, because a user
 *     who sees it on every list row learns to click through it.
 * So there are as many "must NOT ask" cases below as "must ask" ones.
 */

import { describe, expect, it } from "vitest";
import { classifyAction, type ActionContext } from "@/lib/browser/always-ask";

const ask = (ctx: ActionContext) => classifyAction(ctx);

describe("credentials", () => {
  it("asks before typing into a password field", () => {
    const v = ask({
      action: "fill",
      url: "https://app.test/login",
      target: { tag: "input", type: "password" },
      value: "hunter2",
    });
    expect(v.ask).toBe(true);
    expect(v.category).toBe("credentials");
  });

  it("asks on autocomplete tokens, including inside a token list", () => {
    for (const ac of [
      "current-password",
      "new-password",
      "one-time-code",
      "section-a billing current-password",
    ]) {
      const v = ask({
        action: "fill",
        target: { tag: "input", autocomplete: ac },
      });
      expect(v.category, ac).toBe("credentials");
    }
  });

  it("asks on an unlabelled OTP field found by name or placeholder", () => {
    for (const t of [
      { name: "otp" },
      { id: "totp-code" },
      { ariaLabel: "Verification code" },
      { placeholder: "Security code" },
      { name: "ssn" },
    ]) {
      expect(
        ask({ action: "fill", target: { tag: "input", ...t } }).category,
      ).toBe("credentials");
    }
  });

  it("NEVER puts the typed value in the reason", () => {
    // This string is rendered, and may be logged, on the password path.
    const v = ask({
      action: "fill",
      target: { tag: "input", type: "password" },
      value: "correct-horse-battery-staple",
    });
    expect(v.reason).toBeTruthy();
    expect(v.reason).not.toContain("correct-horse");
  });

  it("does not ask merely to CLICK a password field", () => {
    // Focusing a field reveals nothing; entering one is the act that matters.
    expect(
      ask({ action: "click", target: { tag: "input", type: "password" } }).ask,
    ).toBe(false);
  });
});

describe("payment", () => {
  it("asks on card autocomplete tokens", () => {
    for (const ac of ["cc-number", "cc-csc", "cc-exp"]) {
      expect(
        ask({ action: "fill", target: { tag: "input", autocomplete: ac } })
          .category,
      ).toBe("payment");
    }
  });

  it("asks when the VALUE is a valid card number in an unlabelled field", () => {
    // Last line of defence: plenty of checkout forms carry no autocomplete.
    const v = ask({
      action: "fill",
      target: { tag: "input", name: "field_3" },
      value: "4242424242424242",
    });
    expect(v.category).toBe("payment");
  });

  it("does not mistake an order number for a card number", () => {
    // 16 digits, fails Luhn.
    expect(
      ask({
        action: "fill",
        target: { tag: "input", name: "order" },
        value: "1234567890123456",
      }).ask,
    ).toBe(false);
    // Right shape, too short.
    expect(
      ask({ action: "fill", target: { tag: "input" }, value: "424242424242" })
        .ask,
    ).toBe(false);
  });

  it("asks on a submit button inside a form that collects card details", () => {
    const v = ask({
      action: "click",
      target: {
        tag: "button",
        text: "Continue",
        formAutocomplete: ["cc-number", "cc-exp"],
      },
    });
    expect(v.category).toBe("payment");
  });

  it("asks on money phrases", () => {
    for (const text of [
      "Place order",
      "Pay now",
      "Buy now",
      "Checkout",
      "Donate",
      "Confirm payment",
    ]) {
      expect(
        ask({ action: "click", target: { tag: "button", text } }).category,
        text,
      ).toBe("payment");
    }
  });

  it("does NOT fire on reading about payments", () => {
    for (const text of [
      "Payment history",
      "Paypal login",
      "Payout settings",
      "Billing",
    ]) {
      expect(
        ask({ action: "click", target: { tag: "a", text } }).ask,
        text,
      ).toBe(false);
    }
  });
});

describe("destructive", () => {
  it("asks on phrases that mean something is gone for good", () => {
    for (const text of [
      "Delete account",
      "Permanently delete",
      "Delete repository",
      "Delete all",
      "Cancel subscription",
      "Drop database",
    ]) {
      expect(
        ask({ action: "click", target: { tag: "button", text } }).category,
        text,
      ).toBe("destructive");
    }
  });

  it("does NOT fire on a bare delete/remove, which is every list row on the web", () => {
    // A gate that fires here is a gate the user learns to dismiss.
    for (const text of [
      "Delete",
      "Remove",
      "Remove tag",
      "Delete draft",
      "Clear",
    ]) {
      expect(
        ask({ action: "click", target: { tag: "button", text } }).ask,
        text,
      ).toBe(false);
    }
  });
});

describe("downloads and the agent's own settings", () => {
  it("always asks before a file lands on disk", () => {
    expect(
      ask({ action: "download", url: "https://x.test/a.zip" }).category,
    ).toBe("download");
  });

  it("asks on any page that could change the agent's own permissions", () => {
    for (const url of [
      "chrome-extension://abc/options.html",
      "chrome://settings/content",
      "edge://extensions",
      "brave://settings",
      "about:addons",
    ]) {
      expect(
        ask({ action: "click", url, target: { tag: "button", text: "OK" } })
          .category,
        url,
      ).toBe("agent_settings");
    }
  });

  it("gates settings pages even for a read-shaped action", () => {
    expect(
      ask({
        action: "fill",
        url: "chrome://settings",
        target: { tag: "input" },
      }).category,
    ).toBe("agent_settings");
  });
});

describe("ordinary work is never gated", () => {
  it("allows reads and navigation", () => {
    for (const action of ["hover", "scroll", "navigate"] as const) {
      expect(ask({ action, url: "https://airtable.test/x" }).ask, action).toBe(
        false,
      );
    }
  });

  it("allows the everyday case this product exists for", () => {
    expect(
      ask({
        action: "fill",
        url: "https://airtable.test/base",
        target: { tag: "input", name: "cell-B4", ariaLabel: "Status" },
        value: "Shipped",
      }).ask,
    ).toBe(false);
    expect(
      ask({
        action: "click",
        url: "https://airtable.test/base",
        target: { tag: "button", text: "Save" },
      }).ask,
    ).toBe(false);
  });

  it("is total — an action with no target never throws", () => {
    for (const action of [
      "click",
      "fill",
      "key",
      "hover",
      "scroll",
      "navigate",
    ] as const) {
      expect(() => ask({ action })).not.toThrow();
    }
  });
});
