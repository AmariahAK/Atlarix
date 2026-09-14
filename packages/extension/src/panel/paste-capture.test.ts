/**
 * When a paste becomes an attachment.
 *
 * The thresholds are the desktop's, and the boundaries are asserted exactly
 * because "roughly 500" is how the two surfaces end up behaving differently on
 * the same paste.
 */

import { describe, expect, it } from "vitest";
import {
  LONG_PASTE_CHARS,
  LONG_PASTE_LINES,
  clipboardPlainText,
  pasteDisplayName,
  pasteLineCount,
  pasteSignature,
  shouldCaptureAsPaste,
} from "./paste-capture";

describe("the character threshold", () => {
  it("is strictly greater — exactly 500 stays inline", () => {
    expect(shouldCaptureAsPaste("x".repeat(LONG_PASTE_CHARS))).toBe(false);
    expect(shouldCaptureAsPaste("x".repeat(LONG_PASTE_CHARS + 1))).toBe(true);
  });

  it("measures the TRIMMED text", () => {
    // Otherwise a short paste with a lot of trailing whitespace — which is most
    // pastes from a terminal — becomes an attachment for no reason.
    const padded = `${" ".repeat(600)}hello${" ".repeat(600)}`;
    expect(shouldCaptureAsPaste(padded)).toBe(false);
  });
});

describe("the line threshold", () => {
  it("is strictly greater — exactly 20 lines stays inline", () => {
    const at = Array.from({ length: LONG_PASTE_LINES }, () => "a").join("\n");
    const over = Array.from({ length: LONG_PASTE_LINES + 1 }, () => "a").join("\n");
    expect(shouldCaptureAsPaste(at)).toBe(false);
    expect(shouldCaptureAsPaste(over)).toBe(true);
  });

  it("catches a short stack trace that no character count would", () => {
    // 25 lines of "at foo" is well under 500 characters and is exactly the
    // thing you do not want filling a one-line composer.
    const trace = Array.from({ length: 25 }, () => "at f").join("\n");
    expect(trace.length).toBeLessThan(LONG_PASTE_CHARS);
    expect(shouldCaptureAsPaste(trace)).toBe(true);
  });

  it("counts a string with no newline as one line", () => {
    expect(pasteLineCount("hello")).toBe(1);
    expect(pasteLineCount("a\nb")).toBe(2);
  });
});

describe("what never captures", () => {
  it("leaves an empty or whitespace-only paste alone", () => {
    expect(shouldCaptureAsPaste("")).toBe(false);
    expect(shouldCaptureAsPaste("   \n\n  ")).toBe(false);
  });

  it("leaves an ordinary sentence alone", () => {
    expect(shouldCaptureAsPaste("what does this file do?")).toBe(false);
  });
});

describe("the chip's name", () => {
  it("counts lines and gets the plural right", () => {
    expect(pasteDisplayName("one line")).toBe("Pasted text · 1 line");
    expect(pasteDisplayName("a\nb\nc")).toBe("Pasted text · 3 lines");
  });
});

describe("reading the clipboard", () => {
  const transfer = (data: Record<string, string>) =>
    ({ getData: (t: string) => data[t] ?? "" }) as unknown as DataTransfer;

  it("prefers plain text", () => {
    expect(clipboardPlainText(transfer({ "text/plain": "hi" }))).toBe("hi");
  });

  it("falls back to the HTML flavour when plain is empty", () => {
    // Notes, TextEdit and every word processor populate only `text/html`.
    // Without this the feature silently never fires for any of them.
    const out = clipboardPlainText(
      transfer({ "text/plain": "", "text/html": "<p>hello <b>there</b></p>" }),
    );
    expect(out).toBe("hello there");
  });

  it("falls back when plain text is only whitespace", () => {
    const out = clipboardPlainText(
      transfer({ "text/plain": "   ", "text/html": "<p>real</p>" }),
    );
    expect(out).toBe("real");
  });

  it("returns what it has when there is no HTML either", () => {
    expect(clipboardPlainText(transfer({}))).toBe("");
  });
});

describe("dedupe", () => {
  it("gives the same signature to the same content", () => {
    const text = "x".repeat(5_000);
    expect(pasteSignature(text)).toBe(pasteSignature(text));
  });

  it("separates content that differs in the middle", () => {
    // The signature is cheap — length plus both ends — so this is the case to
    // check: two strings agreeing on everything the signature looks at except
    // that they are different lengths.
    expect(pasteSignature("a".repeat(100))).not.toBe(
      pasteSignature("a".repeat(101)),
    );
    expect(pasteSignature("start-MIDDLE-end")).not.toBe(
      pasteSignature("start-OTHERR-end"),
    );
  });
});
