/**
 * Limits and money, said plainly: a BYOK provider's refusal is told apart by
 * what it says (src/shared/texts.ts), and the terminal turns each into a title
 * and a way out (src/cli/tui/limits.ts).
 */
import { describe, expect, it } from "vitest";
import { byokLimitUserMessage } from "@/shared/texts";
import { coreExhaustedUserMessage, freeUsageLimitUserMessage } from "@/shared/billing_copy";
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
  it("free usage over says come back tomorrow and when, and nothing more", () => {
    const n = errorNotice(freeUsageLimitUserMessage(3600, Date.UTC(2026, 9, 3, 10), "UTC"));
    expect(n.title).toBe("Today's usage is over. Come back tomorrow (it resets at 11:00 AM).");
    expect(n.actions).toBeUndefined();
    expect(n.tone).toBe("warn");
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
