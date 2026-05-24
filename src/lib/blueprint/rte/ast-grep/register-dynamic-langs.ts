/**
 * Register Python and Go tree-sitter grammars for ast-grep structural scans.
 * Must run once before findInFiles on those languages (main process + worker).
 * Packaged apps load parser.so from Resources/ast-grep-grammars or app.asar.unpacked.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { registerDynamicLanguage } from "@ast-grep/napi";
import log from "electron-log";

const logger = log.scope("ast-grep:langs");

const PLATFORM_MAP: Record<string, string> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
};

const ARCH_MAP: Record<string, string> = {
  x64: "X64",
  arm64: "ARM64",
};

type LangPackage = "@ast-grep/lang-python" | "@ast-grep/lang-go";

const PACKAGE_TO_LANG_KEY: Record<LangPackage, "python" | "go"> = {
  "@ast-grep/lang-python": "python",
  "@ast-grep/lang-go": "go",
};

type LangMeta = {
  libraryPath: string;
  extensions: string[];
  languageSymbol?: string;
  expandoChar?: string;
};

let registered = false;
const registeredLangKeys = new Set<string>();

function parserFileName(): string {
  return process.platform === "win32" ? "parser.dll" : "parser.so";
}

function prebuildParserPath(pkgDir: string): string | null {
  const os = PLATFORM_MAP[process.platform];
  const arch = ARCH_MAP[process.arch];
  if (!os || !arch) return null;
  const candidate = path.join(pkgDir, "prebuilds", `prebuild-${os}-${arch}`, parserFileName());
  return fs.existsSync(candidate) ? candidate : null;
}

function packageDirFromModule(packageName: LangPackage): string {
  return path.dirname(require.resolve(`${packageName}/package.json`));
}

function stagedGrammarPath(langKey: "python" | "go"): string | null {
  if (!process.resourcesPath) return null;
  const candidate = path.join(
    process.resourcesPath,
    "ast-grep-grammars",
    langKey,
    parserFileName(),
  );
  return fs.existsSync(candidate) ? candidate : null;
}

/** Resolve parser.so on a real filesystem path (unpacked asar or extraResource in production). */
export function resolveAstGrepLangLibraryPath(packageName: LangPackage): string | null {
  const langKey = PACKAGE_TO_LANG_KEY[packageName];

  const fromStaging = stagedGrammarPath(langKey);
  if (fromStaging) {
    logger.info(`resolved ${packageName} library (extraResource)`, { path: fromStaging });
    return fromStaging;
  }

  if (process.resourcesPath) {
    const unpackedPkg = path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "node_modules",
      packageName,
    );
    const fromUnpack = prebuildParserPath(unpackedPkg);
    if (fromUnpack) {
      logger.info(`resolved ${packageName} library (unpacked)`, { path: fromUnpack });
      return fromUnpack;
    }
  }

  try {
    const pkgDir = packageDirFromModule(packageName);
    const fromDev = prebuildParserPath(pkgDir);
    if (fromDev) return fromDev;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(packageName) as { libraryPath: string };
    if (mod.libraryPath && fs.existsSync(mod.libraryPath)) {
      return mod.libraryPath;
    }
  } catch (err) {
    logger.warn(`failed to resolve ${packageName}`, err);
  }
  return null;
}

function loadLangMeta(packageName: LangPackage): LangMeta | null {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(packageName) as LangMeta;
  const libraryPath = resolveAstGrepLangLibraryPath(packageName);
  if (!libraryPath) {
    logger.warn(`${packageName}: no parser.so on disk — skipping dynamic language`);
    return null;
  }
  return {
    libraryPath,
    extensions: mod.extensions,
    languageSymbol: mod.languageSymbol,
    expandoChar: mod.expandoChar,
  };
}

export function isAstGrepDynamicLangRegistered(langKey: "python" | "go"): boolean {
  return registeredLangKeys.has(langKey);
}

export function ensureAstGrepDynamicLangs(): void {
  if (registered) return;

  const langs: Record<string, LangMeta> = {};
  const python = loadLangMeta("@ast-grep/lang-python");
  if (python) langs.python = python;
  const go = loadLangMeta("@ast-grep/lang-go");
  if (go) langs.go = go;

  if (Object.keys(langs).length === 0) {
    logger.warn("no ast-grep dynamic languages registered — Python/Go edges disabled");
    registered = true;
    return;
  }

  registerDynamicLanguage(langs);
  for (const key of Object.keys(langs)) {
    registeredLangKeys.add(key);
  }
  registered = true;
  logger.info("ast-grep dynamic languages registered", { langs: [...registeredLangKeys] });
}

/** @internal Test hook */
export function resetAstGrepDynamicLangsForTests(): void {
  registered = false;
  registeredLangKeys.clear();
}
