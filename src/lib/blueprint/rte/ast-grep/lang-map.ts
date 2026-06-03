/**
 * Map file extension → @ast-grep/napi language id (built-in or dynamic).
 */

import { Lang } from "@ast-grep/napi";

/** `@ast-grep/napi` dropped its `NapiLang` export; dynamic langs are cast to `Lang`. */
export type NapiLang = Lang;

export const LANG_PYTHON = "python" as NapiLang;
export const LANG_GO = "go" as NapiLang;

const EXT_TO_LANG: Record<string, NapiLang> = {
  ".ts": Lang.TypeScript,
  ".tsx": Lang.Tsx,
  ".js": Lang.JavaScript,
  ".jsx": Lang.JavaScript,
  ".mjs": Lang.JavaScript,
  ".cjs": Lang.JavaScript,
  ".py": LANG_PYTHON,
  ".go": LANG_GO,
};

export function langForExtension(ext: string): NapiLang | null {
  return EXT_TO_LANG[ext.toLowerCase()] ?? null;
}

export function isAstGrepSupportedPath(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return ext in EXT_TO_LANG;
}

export const AST_GREP_EXTENSIONS = Object.keys(EXT_TO_LANG);

export function isDynamicAstGrepLang(lang: NapiLang): boolean {
  return lang === LANG_PYTHON || lang === LANG_GO;
}
