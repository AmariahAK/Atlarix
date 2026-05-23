import { Lang, pattern, type NapiConfig, type NapiLang } from "@ast-grep/napi";
import { LANG_GO, LANG_PYTHON } from "../lang-map";

export function importPatterns(lang: NapiLang): NapiConfig[] {
  if (lang === LANG_PYTHON) {
    return [
      pattern(LANG_PYTHON, "import $PATH"),
      pattern(LANG_PYTHON, "from $PATH import $$$"),
    ];
  }
  if (lang === LANG_GO) {
    return [
      pattern(LANG_GO, 'import "$PATH"'),
      pattern(LANG_GO, 'import $ALIAS "$PATH"'),
    ];
  }
  return [
    pattern(lang as Lang, "import $$$ from '$PATH'"),
    pattern(lang as Lang, "import '$PATH'"),
    pattern(lang as Lang, "export $$$ from '$PATH'"),
    pattern(lang as Lang, "require('$PATH')"),
    pattern(lang as Lang, "import('$PATH')"),
  ];
}

export const IMPORT_CAPTURE = "PATH";
