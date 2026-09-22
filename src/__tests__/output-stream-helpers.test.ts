import { describe, it, expect } from "vitest";
import {
  appendCapped,
  pushRing,
  stripAnsi,
  LIVE_OUTPUT_TAIL_CAP,
} from "@/lib/chat/output-stream";

/**
 * The shared helpers the delta path is built on.
 *
 * `appendCapped` is the one that matters: it is what stops a 50 MB build log
 * being retained in React state now that the in-chat card APPENDS deltas instead
 * of replacing with the accumulated buffer. Get the cap wrong and the memory
 * problem this change exists to fix comes straight back, just more slowly.
 */
describe("appendCapped", () => {
  it("appends while under the cap", () => {
    expect(appendCapped("abc", "def")).toBe("abcdef");
    expect(appendCapped("", "first")).toBe("first");
  });

  it("an empty delta is a no-op, and does not re-allocate", () => {
    const existing = "x".repeat(1000);
    expect(appendCapped(existing, "")).toBe(existing);
  });

  it("keeps a bounded TAIL once the cap is passed", () => {
    // The tail, not the head: a running command's interesting output is the most
    // recent, and the full text is still in the tool result and the Terminal tab.
    const out = appendCapped("A".repeat(50), "B".repeat(100), 60);
    expect(out.length).toBe(61); // 60 + the ellipsis marker
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("B")).toBe(true);
    expect(out).not.toContain("A");
  });

  it("stays bounded across many appends — the actual failure mode", () => {
    // 5,000 chunks of 1 KB is 5 MB of output. Before the cap this was retained
    // whole, per command, for as long as the card lived.
    let acc = "";
    for (let i = 0; i < 5_000; i++) acc = appendCapped(acc, "y".repeat(1024));
    expect(acc.length).toBeLessThanOrEqual(LIVE_OUTPUT_TAIL_CAP + 1);
  });
});

describe("pushRing", () => {
  it("appends and keeps the last max", () => {
    expect(pushRing(["a", "b"], ["c"], 3)).toEqual(["a", "b", "c"]);
    expect(pushRing(["a", "b", "c"], ["d"], 3)).toEqual(["b", "c", "d"]);
  });

  it("a zero or negative max keeps nothing", () => {
    expect(pushRing(["a"], ["b"], 0)).toEqual([]);
  });

  it("does not mutate its input", () => {
    const buf = ["a"];
    pushRing(buf, ["b"], 5);
    expect(buf).toEqual(["a"]);
  });
});

describe("stripAnsi", () => {
  it("removes SGR colour codes and keeps the text", () => {
    expect(stripAnsi("\u001b[32mgreen\u001b[0m")).toBe("green");
  });

  it("leaves a carriage return alone", () => {
    // `\r` redraws are meaningful liveness downstream (background-commands treats
    // them as activity), so this must not swallow them.
    expect(stripAnsi("progress\r")).toBe("progress\r");
  });

  it("is safe on a whole line, which is what the emitter guarantees", () => {
    const line = "\u001b[1;31mERROR\u001b[0m something failed\n";
    expect(stripAnsi(line)).toBe("ERROR something failed\n");
  });
});
