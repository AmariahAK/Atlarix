/**
 * The languages Atlarix ships, and the ONLY place the list is written down.
 *
 * Three consumers must agree on it — the settings schema, the i18n runtime, and
 * the MSIX manifest's `<Resource Language>` block (which is what the Microsoft
 * Store derives its "Supported languages" field from). Maintaining that list in
 * three places is how they drift, so everything reads this.
 *
 * ALL THIRTEEN ARE LEFT-TO-RIGHT. No Arabic, Hebrew, Persian or Urdu, so there is
 * deliberately NO bidi work anywhere in the app: no `dir` switching, no
 * logical-property migration, and the ~77 physical `ml-`/`mr-` Tailwind classes
 * stay as they are. Adding an RTL locale here would silently break layout
 * everywhere, which is why `check:i18n` fails loudly if one appears.
 *
 * The hazards that DO bite are not RTL:
 *   - **Expansion.** German, Russian and Polish run 30-40% longer than English.
 *     That, not direction, is the layout budget — the settings tab strip and the
 *     chat header are the exposed spots.
 *   - **Font coverage.** Geist has no CJK or Devanagari glyphs, so zh/ja/ko/hi
 *     fall through to a generic fallback with mismatched metrics unless the stack
 *     names real faces.
 *   - **Turkish casing.** Chromium only applies dotted/dotless-I rules when the
 *     document's `lang` says `tr`, and the renderer has 29 `uppercase` classes.
 */
export const SUPPORTED_LOCALES = [
  "en-us",
  "zh-hans",
  "fr",
  "de",
  "hi",
  "it",
  "ja",
  "ko",
  "pl",
  "pt-br",
  "ru",
  "es",
  "tr",
] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** The locale everything falls back to, and the only catalog bundled eagerly. */
export const DEFAULT_LOCALE: SupportedLocale = "en-us";

/**
 * Right-to-left scripts, for the guard rather than for the app.
 *
 * Nothing reads this at runtime — it exists so `scripts/check-i18n.mjs` can fail
 * the build if one is added to SUPPORTED_LOCALES without the bidi work that would
 * then be required.
 */
export const RTL_LANGUAGE_CODES = ["ar", "he", "fa", "ur", "yi", "dv", "ps"];

/** Human names, for the settings picker. Endonyms — a user looking for their own
 *  language scans for the word they call it, not for the English exonym. */
export const LOCALE_LABELS: Record<SupportedLocale, string> = {
  "en-us": "English",
  "zh-hans": "简体中文",
  fr: "Français",
  de: "Deutsch",
  hi: "हिन्दी",
  it: "Italiano",
  ja: "日本語",
  ko: "한국어",
  pl: "Polski",
  "pt-br": "Português (Brasil)",
  ru: "Русский",
  es: "Español",
  tr: "Türkçe",
};

/** The English name, for the response-language prompt instruction — the model
 *  reasons about "French" far more reliably than about "fr" or "Français". */
export const LOCALE_ENGLISH_NAMES: Record<SupportedLocale, string> = {
  "en-us": "English",
  "zh-hans": "Simplified Chinese",
  fr: "French",
  de: "German",
  hi: "Hindi",
  it: "Italian",
  ja: "Japanese",
  ko: "Korean",
  pl: "Polish",
  "pt-br": "Brazilian Portuguese",
  ru: "Russian",
  es: "Spanish",
  tr: "Turkish",
};

export function isSupportedLocale(v: unknown): v is SupportedLocale {
  return (
    typeof v === "string" &&
    (SUPPORTED_LOCALES as readonly string[]).includes(v)
  );
}
