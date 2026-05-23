/**
 * Register Python and Go tree-sitter grammars for ast-grep structural scans.
 * Must run once before findInFiles on those languages (main process + worker).
 */

import { registerDynamicLanguage } from "@ast-grep/napi";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const python = require("@ast-grep/lang-python") as {
  libraryPath: string;
  extensions: string[];
  languageSymbol?: string;
  expandoChar?: string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const go = require("@ast-grep/lang-go") as {
  libraryPath: string;
  extensions: string[];
  languageSymbol?: string;
  expandoChar?: string;
};

let registered = false;

export function ensureAstGrepDynamicLangs(): void {
  if (registered) return;
  registerDynamicLanguage({
    python: {
      libraryPath: python.libraryPath,
      extensions: python.extensions,
      languageSymbol: python.languageSymbol,
      expandoChar: python.expandoChar,
    },
    go: {
      libraryPath: go.libraryPath,
      extensions: go.extensions,
      languageSymbol: go.languageSymbol,
      expandoChar: go.expandoChar,
    },
  });
  registered = true;
}

/** @internal Test hook */
export function resetAstGrepDynamicLangsForTests(): void {
  registered = false;
}
