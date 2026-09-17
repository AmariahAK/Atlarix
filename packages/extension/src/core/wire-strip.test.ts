/**
 * Reasoning is STORED but NEVER SENT.
 *
 * Both halves matter and they pull against each other. Keeping it is what makes
 * a bug report diagnosable — the panel used to stream the model's thinking into
 * a local variable and drop it the moment the answer began, so "it said it
 * could not see the page" left nothing behind to read. Sending it back is a
 * different thing entirely: it is in no provider's message schema, it is large,
 * and handing a model its own private chain back as conversation makes it treat
 * the chain as something it said out loud.
 *
 * `streamTurn` maps every message through this on the way out, so the guard
 * lives at the boundary rather than in each caller.
 */
import { describe, expect, it } from "vitest";
import { stripForWire, type CoreMessage } from "./client";

describe("stripForWire", () => {
  it("removes reasoning from an assistant message", () => {
    const out = stripForWire({
      role: "assistant",
      content: "hello",
      reasoning: "SECRET CHAIN",
    });
    expect(out).toEqual({ role: "assistant", content: "hello" });
    expect(JSON.stringify(out)).not.toContain("SECRET CHAIN");
  });

  it("keeps tool_calls, which the provider DOES need", () => {
    const calls = [
      { id: "c1", type: "function" as const, function: { name: "read_page", arguments: "{}" } },
    ];
    const out = stripForWire({
      role: "assistant",
      content: null,
      tool_calls: calls,
      reasoning: "why I read it",
    });
    expect(out).toEqual({ role: "assistant", content: null, tool_calls: calls });
  });

  it("returns the SAME object when there is nothing to strip", () => {
    // Identity matters: this runs over every message of every request, and a
    // fresh object per message per turn is pure garbage for no benefit.
    const m: CoreMessage = { role: "user", content: "hi" };
    expect(stripForWire(m)).toBe(m);
    const a: CoreMessage = { role: "assistant", content: "x" };
    expect(stripForWire(a)).toBe(a);
  });

  it("leaves user and tool messages alone", () => {
    const t: CoreMessage = { role: "tool", tool_call_id: "c1", content: "{}" };
    expect(stripForWire(t)).toEqual(t);
  });
});
