/**
 * Truncation must not split a character.
 *
 * Every helper here cuts a JS string by INDEX, and a non-BMP character (emoji,
 * CJK extensions, historic scripts) is two code units. Landing between them
 * leaves a lone surrogate, which is not valid UTF-8 — so `JSON.stringify` emits
 * an unpaired `\udXXX` escape and some providers reject the request. A grep that
 * matched a line containing an emoji could therefore fail the turn.
 *
 * Found by checking opencode #42356 ("preserve unicode in grep previews")
 * against our own code.
 */
import { describe, it, expect } from "vitest";
import {
  truncateToTokens,
  headTailTruncateToTokens,
  truncateUtf8ByBytes,
} from "@/lib/truncate";

/** True if any code unit is an unpaired surrogate. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** JSON round-trips iff the string is well-formed. */
function survivesJson(s: string): boolean {
  return JSON.parse(JSON.stringify({ s })).s === s;
}

const EMOJI = "😀";

describe("truncateToTokens", () => {
  it("never leaves a lone surrogate, at any cut point", () => {
    // Sweep the budget so the boundary lands mid-pair somewhere in the range.
    // Kept small on purpose: `estimateTokens` runs a real tokenizer and the
    // binary search calls it O(log n) times PER budget, so a big string times a
    // wide sweep is how this file ends up racing the suite timeout.
    const content = `${"x".repeat(20)}${EMOJI.repeat(40)}`;
    for (let maxTokens = 1; maxTokens <= 10; maxTokens++) {
      const out = truncateToTokens(content, maxTokens);
      expect(hasLoneSurrogate(out), `maxTokens=${maxTokens}`).toBe(false);
      expect(survivesJson(out), `maxTokens=${maxTokens}`).toBe(true);
    }
  });

  it("still returns short content untouched", () => {
    expect(truncateToTokens(`ok ${EMOJI}`, 1_000)).toBe(`ok ${EMOJI}`);
  });
});

describe("headTailTruncateToTokens", () => {
  /** Both ends cut, so both ends can orphan a half — high at the head, low at the tail. */
  it("never leaves a lone surrogate at either boundary", () => {
    const content = `${EMOJI.repeat(40)}MIDDLE${EMOJI.repeat(40)}`;
    for (let tokens = 1; tokens <= 8; tokens++) {
      const { text } = headTailTruncateToTokens(content, tokens, tokens);
      expect(hasLoneSurrogate(text), `tokens=${tokens}`).toBe(false);
      expect(survivesJson(text), `tokens=${tokens}`).toBe(true);
    }
  });
});

describe("truncateUtf8ByBytes", () => {
  /**
   * Buffer#toString never yields a lone surrogate — it yields U+FFFD for a
   * half-copied sequence, so the last character silently became `�`. Dropping
   * the partial character loses the same glyph without inventing one.
   */
  it("does not emit a replacement character for a half-copied sequence", () => {
    const content = `${"x".repeat(50)}${EMOJI.repeat(50)}`;
    for (let maxBytes = 55; maxBytes < 200; maxBytes++) {
      const out = truncateUtf8ByBytes(content, maxBytes, {
        margin: 0,
        suffix: "",
      });
      expect(out.includes("�"), `maxBytes=${maxBytes}`).toBe(false);
      expect(hasLoneSurrogate(out), `maxBytes=${maxBytes}`).toBe(false);
    }
  });

  it("still returns content under the cap untouched", () => {
    expect(truncateUtf8ByBytes(`ok ${EMOJI}`, 10_000)).toBe(`ok ${EMOJI}`);
  });

  it("appends the suffix when it does truncate", () => {
    const out = truncateUtf8ByBytes("y".repeat(500), 200);
    expect(out).toContain("truncated: exceeded max_bytes");
  });
});
