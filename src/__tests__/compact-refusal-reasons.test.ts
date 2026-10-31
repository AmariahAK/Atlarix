/**
 * /compact said "the conversation is still short" on a 300k-token session
 * (owner, 2026-10-31), because three different causes shared one message.
 * Each one now says what actually happened.
 */
import { describe, expect, it } from "vitest";
import { compactResultMessage } from "@/lib/context/compact-result-message";

describe("why /compact did not compact", () => {
  it("a big session that freed nothing says so, with its size — never 'still short'", () => {
    const { ok, message } = compactResultMessage({ ok: false, reason: "nothing-freed", tokens: 302_000 });
    expect(ok).toBe(false);
    expect(message).toContain("302k tokens");
    expect(message).not.toContain("still short");
  });
  it("history that is no longer in memory is its own cause", () => {
    const { message } = compactResultMessage({ ok: false, reason: "no-history" });
    expect(message).toContain("isn't in memory");
    expect(message).not.toContain("still short");
  });
  it("a genuinely short conversation still says short, and a failed summary still says that", () => {
    expect(compactResultMessage({ ok: false, reason: "short" }).message).toContain("still short");
    expect(compactResultMessage({ ok: false, reason: "failed" }).message).toContain("didn't return a summary");
  });
});
