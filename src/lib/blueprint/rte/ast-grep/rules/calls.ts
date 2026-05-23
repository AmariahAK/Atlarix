import { Lang, pattern, type NapiConfig, type NapiLang } from "@ast-grep/napi";
import { LANG_GO, LANG_PYTHON } from "../lang-map";

export function callPatterns(lang: NapiLang): NapiConfig[] {
  if (lang === LANG_PYTHON || lang === LANG_GO) {
    return [pattern(lang, "$CALLEE($$$)")];
  }
  return [pattern(lang as Lang, "$CALLEE($$$)")];
}

export const CALLEE_CAPTURE = "CALLEE";
