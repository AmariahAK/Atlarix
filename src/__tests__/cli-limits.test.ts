/**
 * Limits and money, said plainly: a BYOK provider's refusal is told apart by
 * what it says (src/shared/texts.ts), and the terminal turns each into a title
 * and a way out (src/cli/tui/limits.ts).
 */
import { describe, expect, it } from "vitest";
import { byokLimitUserMessage } from "@/shared/texts";
import {
  coreExhaustedUserMessage,
  coreRefusalMessage,
  freeAutoBusyMessage,
  freeAutoLimitMessage,
  parseCreditRefusal,
} from "@/shared/billing_copy";
import { errorNotice } from "@/cli/tui/limits";

describe("your own key's limits", () => {
  it("out of credit, by what any provider says", () => {
    for (const said of [
      '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota"}}',
      '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}',
      '{"error":{"message":"Insufficient Balance","type":"unknown_error"}}',
      "402 Payment Required",
    ]) {
      expect(byokLimitUserMessage(said, "deepseek")).toMatch(/^Your deepseek account is out of credit or over its quota/);
    }
  });

  it("rate-limited, and a bad key, are their own messages", () => {
    expect(byokLimitUserMessage("429 Too Many Requests: rate limit reached", "openai")).toMatch(/openai is rate-limiting your key/);
    expect(byokLimitUserMessage('{"error":{"message":"Incorrect API key provided"}}', "openai")).toMatch(/openai rejected your API key/);
    expect(byokLimitUserMessage("context length exceeded", "openai")).toBeNull();
  });
});

describe("the terminal's notice", () => {
  it("free Auto used up: when it resets, and the ways to keep going", () => {
    const now = Date.UTC(2026, 9, 3, 10);
    const n = errorNotice(freeAutoLimitMessage(now + (3 * 60 + 20) * 60_000, now));
    expect(n.title).toBe("Today's free Atlarix Auto is used up");
    expect(n.detail).toBe("Resets in 3h 20m.");
    expect(n.actions).toBe("/billing Pro or credit · /model your own key");
    expect(n.tone).toBe("warn");
  });

  it("free Auto busy can be sent again, with the same ways out", () => {
    const n = errorNotice(freeAutoBusyMessage());
    expect(n.title).toBe("Atlarix Auto's free models are busy right now");
    expect(n.actions).toContain("send it again");
    expect(n.actions).toContain("/billing");
  });

  it("a $0 account that never added credit is told Core runs on credit, with Auto as the way out", () => {
    const text = coreRefusalMessage(parseCreditRefusal('{"error":"insufficient_credit","required_cents":40,"plan":"free","ever_funded":false}'));
    const n = errorNotice(`Sorry, there was an error from the AI: ${text}`);
    expect(n.title).toBe("Atlarix Core runs on credit");
    expect(n.detail).toBe("Add credit or get Pro to use it, or switch to Atlarix Auto (free). This model needs at least $0.40 of credit.");
    expect(n.actions).toBe("/billing add credit or get Pro · /model Atlarix Auto (free) or your own key");
  });

  it("Pro with the allowance spent is never told to get Pro", () => {
    const text = coreRefusalMessage(parseCreditRefusal({ error: "insufficient_credit", plan: "pro", ever_funded: true, renews_at: "2026-11-05T12:00:00Z" }), "UTC");
    const n = errorNotice(text);
    expect(n.title).toBe("Your Pro allowance for this month is used up");
    expect(n.detail).toMatch(/^It resets on /);
    expect(n.actions).toBe("/billing add credit · /model your own key");
    expect(`${n.title} ${n.detail} ${n.actions}`).not.toMatch(/get Pro/i);
  });

  it("Core credit used up names what this turn needs", () => {
    const n = errorNotice(`Sorry, there was an error from the AI: ${coreExhaustedUserMessage(125)}`);
    expect(n.title).toBe("Your Atlarix Core balance is used up");
    expect(n.detail).toBe("This turn needs at least $1.25 available.");
    expect(n.actions).toContain("/model");
  });

  it("a BYOK provider out of credit, and anything else as it was", () => {
    const n = errorNotice(byokLimitUserMessage('{"error":{"message":"Insufficient Balance"}}', "deepseek")!);
    expect(n.title).toBe("Your deepseek account is out of credit or over its quota");
    expect(n.detail).toBe("It said: Insufficient Balance");
    expect(errorNotice("Something odd.")).toEqual({ tone: "error", title: "Something odd." });
  });
});

describe("a provider's words, quoted", () => {
  it("collapses a masked key and cuts at a sentence", async () => {
    const { byokLimitUserMessage } = await import("@/shared/texts");
    const reason = `{"error":{"message":"Incorrect API key provided: sk-proj-${"*".repeat(150)}UcIA. You can find your API key at https://platform.openai.com/account/api-keys. Please check that you are using the right key and that it has not been revoked by an administrator."}}`;
    const m = byokLimitUserMessage(reason, "openai")!;
    const said = /\(It said: "(.*)"\)/.exec(m)![1]!;
    expect(said).toContain("sk-proj-…UcIA.");
    expect(said).not.toContain("****");
    expect(said).toMatch(/[.…]$/);
    expect(said.length).toBeLessThanOrEqual(201);
  });
});
