/**
 * Windows QA 2026-10-14: "Checked sub-agents" showed a sub-agent's reply
 * twice ("`" + "…them. Edge" + the full text). Each text emit is the
 * segment's whole text so far, and the task's progress buffer appended
 * every one. Folding the real emitter's output must give the text once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRollingEmitter } from "@/lib/agents/run-subagent";
import { newSegmentText } from "@/lib/tools/spawn-task";

type Emit = { type: string; id?: string; channel?: string; content?: string };

function fold(emits: Emit[]): string {
  const seen = new Map<string, string>();
  let out = "";
  for (const e of emits) {
    if (e.type !== "subagent_thought" || e.channel !== "text" || !e.id || !e.content) continue;
    out += newSegmentText(seen.get(e.id) ?? "", e.content);
    seen.set(e.id, e.content);
  }
  return out;
}

describe("a sub-agent's progress text", () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => vi.useRealTimers());

  const stream = (deltas: string[]) => {
    const emits: Emit[] = [];
    const r = makeRollingEmitter((p) => emits.push(p as Emit), "d1", 1);
    for (const d of deltas) {
      vi.advanceTimersByTime(500); // past the emit throttle: every delta emits
      r.pushText(d);
    }
    r.finish();
    return emits;
  };

  it("appears once, however many times it was emitted", () => {
    const reply = "`add()` returns `a - b`.\n\nEdge cases: no input checks.";
    const deltas = reply.match(/.{1,6}/gs)!;
    const emits = stream(deltas);
    expect(emits.length).toBeGreaterThan(3);
    expect(fold(emits)).toBe(reply);
  });

  it("stays whole when a long segment arrives capped", () => {
    const words = Array.from({ length: 1200 }, (_, i) => `w${i}`).join(" ");
    const deltas = words.match(/.{1,400}/gs)!;
    const out = fold(stream(deltas));
    expect(out).toBe(words);
  });

  it("adds nothing for a repeated emit", () => {
    expect(newSegmentText("abc", "abc")).toBe("");
    expect(newSegmentText("", "abc")).toBe("abc");
    expect(newSegmentText("abc", "abc def")).toBe(" def");
  });
});
