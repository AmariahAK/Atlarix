import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  type SupportedLocale,
} from "./locales";

/**
 * Resolve the app language, from the setting or the OS.
 *
 * Order:
 *   1. explicit `appLanguage` setting
 *   2. the OS locale, normalised onto the closest shipped catalog
 *   3. `en-us`
 *
 * Modelled on `src/lib/voice/language.ts`, with ONE deliberate divergence.
 * `voiceLanguage` is free-form because any ISO-639-1 code is meaningful to
 * Whisper, so a new language needs no code change. Here a value selects a BUNDLED
 * CATALOG: an unrecognised tag would render a blank UI rather than a degraded
 * one, so anything not in SUPPORTED_LOCALES falls back rather than being passed
 * through.
 *
 * ELECTRON MAIN CALLERS: `app.getLocale()` returns "" until `app.whenReady()`.
 * Use `app.getSystemLocale()` if you need a value before then, or this resolves
 * everyone to English at startup.
 */

/**
 * Map an arbitrary BCP-47-ish tag onto a shipped locale.
 *
 * The interesting cases are the ones where the obvious answer is wrong:
 *   - `zh-TW` / `zh-HK` are TRADITIONAL Chinese. We ship Simplified only, and
 *     showing a Traditional reader Simplified text is worse than English — so
 *     they fall through rather than matching `zh-hans` on the `zh` prefix.
 *   - `pt-PT` gets `pt-br`. Not ideal, but European and Brazilian Portuguese are
 *     mutually readable, and the alternative is English.
 *   - Any `en-*` gets `en-us`; we do not ship regional English variants.
 */
export function normalizeLocaleTag(
  tag: string | null | undefined,
): SupportedLocale | null {
  const raw = tag?.trim().toLowerCase().replace(/_/g, "-");
  if (!raw) return null;

  if (isSupportedLocale(raw)) return raw;

  const [lang, ...rest] = raw.split("-");
  const script = rest.find((p) => p.length === 4);
  const region = rest.find((p) => p.length === 2);

  if (lang === "zh") {
    // Script wins when present; otherwise infer from region.
    if (script === "hant") return null;
    if (script === "hans") return "zh-hans";
    if (region === "tw" || region === "hk" || region === "mo") return null;
    return "zh-hans";
  }
  if (lang === "pt") return "pt-br";
  if (lang === "en") return "en-us";

  return isSupportedLocale(lang) ? lang : null;
}

export function resolveAppLocale(
  setting: string | null | undefined,
  osLocale: string | null | undefined,
): SupportedLocale {
  if (isSupportedLocale(setting?.trim()))
    return setting!.trim() as SupportedLocale;
  return normalizeLocaleTag(osLocale) ?? DEFAULT_LOCALE;
}

/** Every shipped locale, for the settings picker. */
export const ALL_LOCALES: readonly SupportedLocale[] = SUPPORTED_LOCALES;
