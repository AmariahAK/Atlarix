import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "./useSettings";
import { changeLocale } from "@/lib/i18n";
import { resolveAppLocale } from "@/lib/i18n/resolve-locale";

/**
 * Apply the resolved app locale to i18next and to the document.
 *
 * Mounted once, high in the tree. It reads `appLanguage` through `useSettings`,
 * which now adopts cross-window changes — so switching language in one window
 * takes effect in every open window without a reload.
 *
 * SETTING `document.documentElement.lang` IS NOT COSMETIC. Chromium applies
 * Turkish's dotted/dotless-I casing rules only when the document says `lang="tr"`,
 * and the renderer has ~29 `uppercase` and 7 `capitalize` classes. Without this,
 * Turkish uppercase labels are subtly and permanently wrong in a way nobody
 * reviewing English screenshots would ever notice.
 */
export function useAppLocale(): void {
  const { settings } = useSettings();
  const { i18n } = useTranslation();

  useEffect(() => {
    const osLocale =
      typeof navigator !== "undefined" ? navigator.language : undefined;
    const locale = resolveAppLocale(settings?.appLanguage, osLocale);
    if (i18n.language === locale) {
      // Still stamp the attribute: a fresh window starts at the default and the
      // element has whatever index.html shipped.
      document.documentElement.lang = locale;
      return;
    }
    void changeLocale(i18n, locale).then((ok) => {
      // On a failed catalog load the instance stays on its previous language, so
      // the attribute must describe what is actually rendered rather than what
      // was asked for — otherwise casing rules apply to the wrong language.
      document.documentElement.lang = ok ? locale : i18n.language;
    });
  }, [settings?.appLanguage, i18n]);
}
