/**
 * App-language resolution, mirroring `voice-language.test.ts` — including its
 * "never emits something the consumer cannot use" section, which here means
 * never emitting a locale we have no catalog for.
 */
import { describe, expect, it } from "vitest";
import {
  normalizeLocaleTag,
  resolveAppLocale,
} from "@/lib/i18n/resolve-locale";
import {
  RTL_LANGUAGE_CODES,
  SUPPORTED_LOCALES,
  isSupportedLocale,
} from "@/lib/i18n/locales";

describe("resolveAppLocale", () => {
  it("prefers an explicit setting over the OS", () => {
    expect(resolveAppLocale("ja", "de-DE")).toBe("ja");
  });

  it("falls back to the OS locale when unset", () => {
    expect(resolveAppLocale(undefined, "de-DE")).toBe("de");
    expect(resolveAppLocale(null, "fr-CA")).toBe("fr");
    expect(resolveAppLocale("", "it-IT")).toBe("it");
  });

  it("falls back to en-us when neither is usable", () => {
    expect(resolveAppLocale(undefined, undefined)).toBe("en-us");
    expect(resolveAppLocale(undefined, "")).toBe("en-us");
    // Electron's app.getLocale() returns "" before app.whenReady().
    expect(resolveAppLocale(null, null)).toBe("en-us");
  });

  it("ignores a setting we have no catalog for", () => {
    // The divergence from voiceLanguage: a free-form tag there is fine because
    // any ISO-639-1 code means something to Whisper. Here it would be a blank UI.
    expect(resolveAppLocale("sw", "de-DE")).toBe("de");
    expect(resolveAppLocale("klingon", undefined)).toBe("en-us");
  });

  it("NEVER returns a locale outside SUPPORTED_LOCALES", () => {
    const inputs = [
      "sw-KE", "xx", "und", "en", "EN-GB", "zh", "zh-Hant-TW", "pt-PT",
      "", "   ", "null", "en_US", "de-DE-1996", "i-klingon",
    ];
    for (const setting of [...inputs, undefined, null]) {
      for (const os of [...inputs, undefined, null]) {
        expect(isSupportedLocale(resolveAppLocale(setting, os))).toBe(true);
      }
    }
  });
});

describe("normalizeLocaleTag", () => {
  it("accepts a shipped tag unchanged", () => {
    for (const l of SUPPORTED_LOCALES) expect(normalizeLocaleTag(l)).toBe(l);
  });

  it("is case- and separator-insensitive", () => {
    expect(normalizeLocaleTag("PT-BR")).toBe("pt-br");
    expect(normalizeLocaleTag("zh_hans")).toBe("zh-hans");
    expect(normalizeLocaleTag("  FR  ")).toBe("fr");
  });

  it("maps every English variant to en-us", () => {
    expect(normalizeLocaleTag("en")).toBe("en-us");
    expect(normalizeLocaleTag("en-GB")).toBe("en-us");
    expect(normalizeLocaleTag("en-AU")).toBe("en-us");
  });

  it("maps European Portuguese to pt-br", () => {
    // Not ideal, but mutually readable — and the alternative is English.
    expect(normalizeLocaleTag("pt-PT")).toBe("pt-br");
    expect(normalizeLocaleTag("pt")).toBe("pt-br");
  });

  it("REFUSES Traditional Chinese rather than serving it Simplified", () => {
    // The trap: a naive `zh` prefix match sends a Traditional reader Simplified
    // text, which is worse for them than English. Script wins when present,
    // region decides otherwise.
    expect(normalizeLocaleTag("zh-Hant")).toBeNull();
    expect(normalizeLocaleTag("zh-Hant-TW")).toBeNull();
    expect(normalizeLocaleTag("zh-TW")).toBeNull();
    expect(normalizeLocaleTag("zh-HK")).toBeNull();
    expect(normalizeLocaleTag("zh-MO")).toBeNull();
  });

  it("accepts Simplified Chinese by script or by region", () => {
    expect(normalizeLocaleTag("zh-Hans")).toBe("zh-hans");
    expect(normalizeLocaleTag("zh-CN")).toBe("zh-hans");
    expect(normalizeLocaleTag("zh-SG")).toBe("zh-hans");
    expect(normalizeLocaleTag("zh")).toBe("zh-hans");
  });

  it("returns null for anything unshipped", () => {
    for (const t of ["sw", "ar", "he", "xx-YY", "und", "", "   ", null, undefined]) {
      expect(normalizeLocaleTag(t)).toBeNull();
    }
  });
});

describe("SUPPORTED_LOCALES", () => {
  it("contains no right-to-left locale", () => {
    // Adding one would silently break layout everywhere — the app has ~77
    // physical ml-/mr- classes and no bidi handling, all descoped deliberately
    // on the basis that these 13 are LTR. If this ever fails, the fix is the
    // bidi work, not deleting the assertion.
    const rtl = SUPPORTED_LOCALES.filter((l) =>
      RTL_LANGUAGE_CODES.includes(l.split("-")[0]!),
    );
    expect(rtl).toEqual([]);
  });

  it("leads with en-us, the statically bundled fallback", () => {
    expect(SUPPORTED_LOCALES[0]).toBe("en-us");
  });

  it("has no duplicates", () => {
    expect(new Set(SUPPORTED_LOCALES).size).toBe(SUPPORTED_LOCALES.length);
  });

  it("is the thirteen the Microsoft Store listing already carries", () => {
    expect(SUPPORTED_LOCALES).toHaveLength(13);
  });
});
