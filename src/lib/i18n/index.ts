import i18next, { type i18n as I18nInstance } from "i18next";
import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  type SupportedLocale,
} from "./locales";

// The default catalog is a STATIC import, not a dynamic one. Three reasons, and
// the third is the one that would hurt to discover late:
//   1. English must be available synchronously — a first paint that renders raw
//      keys and then swaps to text is worse than no i18n at all.
//   2. It is the fallback for every other locale, so it is always needed.
//   3. The ~94 existing English text assertions across the renderer test suite
//      resolve through it. Making it async would mean touching all of them.
import enCommon from "./locales/en-us/common.json";
import enApp from "./locales/en-us/app.json";
import enChat from "./locales/en-us/chat.json";
import enSettings from "./locales/en-us/settings.json";
import enTools from "./locales/en-us/tools.json";
import enOnboarding from "./locales/en-us/onboarding.json";
import enPanels from "./locales/en-us/panels.json";
import enMain from "./locales/en-us/main.json";
import enTips from "./locales/en-us/tips.json";

/**
 * One catalog per SURFACE, so a translation PR touches one JSON file and never
 * conflicts with a sibling PR working on a different part of the app. The
 * migration lands surface by surface; a single `translation.json` would put every
 * one of those PRs in the same merge conflict.
 */
export const NAMESPACES = [
  "common",
  "app",
  "chat",
  "settings",
  "tools",
  "onboarding",
  "panels",
  "main",
  "tips",
] as const;
export type Namespace = (typeof NAMESPACES)[number];

export const EN_RESOURCES = {
  common: enCommon,
  app: enApp,
  chat: enChat,
  settings: enSettings,
  tools: enTools,
  onboarding: enOnboarding,
  panels: enPanels,
  main: enMain,
  tips: enTips,
} as const;

/**
 * Create and initialise an i18next instance.
 *
 * Deliberately NOT the `i18next` singleton: the renderer and the Electron main
 * process each need their own, and main has no React. `i18next` core is
 * framework-free, which is the whole reason it was chosen over Lingui (whose
 * macro would need wiring into two Vite configs plus the headless esbuild path)
 * and react-intl.
 *
 * `initAsync: false` makes init SYNCHRONOUS, which is what lets a test render a
 * component without awaiting anything. Note the name: this was `initImmediate`
 * up to i18next v24 and every tutorial still says so, but v26 renamed it and the
 * old key is silently ignored — you get an async init and tests that see raw keys.
 */
export function createI18n(locale: SupportedLocale = DEFAULT_LOCALE): I18nInstance {
  const instance = i18next.createInstance();
  void instance.init({
    lng: locale,
    fallbackLng: DEFAULT_LOCALE,
    ns: [...NAMESPACES],
    defaultNS: "common",
    resources: { [DEFAULT_LOCALE]: EN_RESOURCES },
    initAsync: false,
    interpolation: {
      // React escapes for us; double-escaping turns an apostrophe into &#39;
      // in the middle of a sentence.
      escapeValue: false,
    },
    // A missing key renders the key itself in production rather than an empty
    // string — a visible "settings.title" is a bug report; a blank label is a
    // mystery. `check:i18n` and the TypeScript key types are what stop it
    // reaching production in the first place.
    parseMissingKeyHandler: (key) => key,
    returnNull: false,
  });
  return instance;
}

/**
 * Load a non-English catalog and switch to it.
 *
 * Dynamic import per namespace so Vite emits one chunk per locale: an English
 * user downloads and parses nothing beyond the static catalogs above.
 *
 * Failing to load is NOT fatal. A missing or corrupt catalog leaves the instance
 * on its previous language, which is a working app in the wrong language —
 * strictly better than a blank one. The caller gets `false` so it can decide
 * whether to say anything.
 */
export async function changeLocale(
  instance: I18nInstance,
  locale: string,
): Promise<boolean> {
  if (!isSupportedLocale(locale)) return false;
  if (locale === DEFAULT_LOCALE) {
    await instance.changeLanguage(locale);
    return true;
  }
  if (instance.hasResourceBundle(locale, "common")) {
    await instance.changeLanguage(locale);
    return true;
  }
  try {
    const loaded = await Promise.all(
      NAMESPACES.map(async (ns) => {
        const mod = await import(`./locales/${locale}/${ns}.json`);
        return [ns, (mod as { default: unknown }).default] as const;
      }),
    );
    for (const [ns, bundle] of loaded) {
      instance.addResourceBundle(locale, ns, bundle, true, true);
    }
    await instance.changeLanguage(locale);
    return true;
  } catch {
    return false;
  }
}
