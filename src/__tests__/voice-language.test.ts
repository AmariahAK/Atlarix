/**
 * Spoken-language resolution for dictation.
 *
 * `language` was never wired through to the engine, so Whisper re-ran language
 * DETECTION on every clip — unreliable on short dictation, and a wrong guess
 * mis-transcribes the whole utterance. This is the resolver that fixed it; the
 * invariant is that it produces a bare ISO-639-1 code or nothing, never a
 * malformed tag that would make the engine fail or silently mis-decode.
 */

import { describe, expect, it } from "vitest";
import { resolveVoiceLanguage } from "@/lib/voice/language";

describe("explicit setting wins", () => {
  it("uses the configured code", () => {
    expect(resolveVoiceLanguage("sw", "en-US")).toBe("sw");
  });

  it("normalizes a full locale tag to the base language", () => {
    expect(resolveVoiceLanguage("pt-BR", "en-US")).toBe("pt");
    expect(resolveVoiceLanguage("zh_CN", "en-US")).toBe("zh");
  });

  it('treats "auto" as a deliberate opt-in to detection', () => {
    // Not a fallback — the user asked for per-clip detection.
    expect(resolveVoiceLanguage("auto", "en-US")).toBeUndefined();
    expect(resolveVoiceLanguage("AUTO", "en-US")).toBeUndefined();
  });
});

describe("falls back to the OS locale, not a hardcoded English", () => {
  it("derives the code from the locale", () => {
    expect(resolveVoiceLanguage(undefined, "sw-KE")).toBe("sw");
    expect(resolveVoiceLanguage(undefined, "fr")).toBe("fr");
  });

  it("returns undefined when the environment reports no locale", () => {
    // Detection is the correct behaviour here — better than forcing a guess.
    // Note `undefined` as the 2nd arg means "not supplied" and falls back to
    // navigator.language; an empty string is the no-locale environment.
    expect(resolveVoiceLanguage(undefined, "")).toBeUndefined();
  });
});

describe("never emits a malformed code", () => {
  it("rejects non-two-letter bases rather than passing them through", () => {
    expect(resolveVoiceLanguage(undefined, "und")).toBeUndefined();
    expect(resolveVoiceLanguage("english", "en-US")).toBeUndefined();
    expect(resolveVoiceLanguage("", "de-DE")).toBe("de");
    expect(resolveVoiceLanguage("   ", "de-DE")).toBe("de");
  });
});
