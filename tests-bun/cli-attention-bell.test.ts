import { describe, expect, it } from "bun:test";
import { attentionSequence } from "../src/cli/tui/App";

describe("the CLI's attention signal (owner, 2026-11-05: the bell and Terminal's count)", () => {
  it("rings the bell even while the terminal is focused", () => {
    expect(attentionSequence("Atlarix finished", true)).toBe("\x07");
  });
  it("adds an OSC 9 notification before the bell while it isn't focused", () => {
    const s = attentionSequence("Atlarix finished: fix\nthe build", false);
    expect(s.startsWith("\x1b]9;Atlarix finished: fix the build\x07")).toBe(true);
    expect(s.endsWith("\x07\x07")).toBe(true);
  });
});
