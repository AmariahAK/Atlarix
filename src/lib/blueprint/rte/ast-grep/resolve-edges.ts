/**
 * Resolve import paths to workspace-relative file paths (TS/JS).
 *
 * v12 Tier 6 #1 fix: alias imports (`@/lib/x`) resolve via tsconfig.json
 * `paths`/`baseUrl` and package.json `imports`/`exports` BEFORE the relative
 * fallback. Without this, every aliased cross-module edge was silently
 * dropped — for a structural-graph retriever, missing edges = the model
 * follows dead ends and over-reads to compensate (the token bloat).
 */

import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

const TS_RESOLVE = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const PY_RESOLVE = [".py"];
const GO_RESOLVE = [".go"];

function resolveExtensions(fromRelFile: string): string[] {
  const ext = path.extname(fromRelFile).toLowerCase();
  if (ext === ".py") return PY_RESOLVE;
  if (ext === ".go") return GO_RESOLVE;
  return TS_RESOLVE;
}

// ── tsconfig paths / baseUrl + package.json imports (cached per root) ────────

interface AliasConfig {
  /** Absolute base dir for non-relative resolution (baseUrl), or null. */
  baseDir: string | null;
  /** Each `paths` mapping: prefix (before `*`) → list of target prefixes. */
  patterns: Array<{ prefix: string; suffix: string; targets: string[] }>;
}

const aliasCache = new Map<string, AliasConfig | null>();

/** Strip // and /* *​/ comments so JSON.parse tolerates tsconfig/JSONC. */
function stripJsonComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/,(\s*[}\]])/g, "$1"); // trailing commas
}

async function readJsonc(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(stripJsonComments(await fs.readFile(file, "utf8")));
  } catch {
    return null;
  }
}

async function loadAliasConfig(projectRoot: string): Promise<AliasConfig | null> {
  if (aliasCache.has(projectRoot)) return aliasCache.get(projectRoot)!;

  const patterns: AliasConfig["patterns"] = [];
  let baseDir: string | null = null;

  // tsconfig.json (+ one level of `extends`).
  let ts = await readJsonc(path.join(projectRoot, "tsconfig.json"));
  const extendsRef = ts?.extends;
  if (typeof extendsRef === "string") {
    const parent = await readJsonc(
      path.join(projectRoot, extendsRef.endsWith(".json") ? extendsRef : `${extendsRef}.json`),
    );
    if (parent) ts = { ...parent, ...ts, compilerOptions: { ...(parent.compilerOptions as object), ...(ts?.compilerOptions as object) } };
  }
  const co = (ts?.compilerOptions ?? {}) as {
    baseUrl?: string;
    paths?: Record<string, string[]>;
  };
  if (typeof co.baseUrl === "string") {
    baseDir = path.resolve(projectRoot, co.baseUrl);
  }
  const pathsBase = baseDir ?? projectRoot;
  for (const [pattern, targetsRaw] of Object.entries(co.paths ?? {})) {
    const star = pattern.indexOf("*");
    const prefix = star >= 0 ? pattern.slice(0, star) : pattern;
    const suffix = star >= 0 ? pattern.slice(star + 1) : "";
    const targets = (Array.isArray(targetsRaw) ? targetsRaw : [])
      .map((t) => path.resolve(pathsBase, t.replace("*", "")));
    patterns.push({ prefix, suffix, targets });
  }

  // package.json self-`imports` (`#x` subpath imports).
  const pkg = await readJsonc(path.join(projectRoot, "package.json"));
  const imports = (pkg?.imports ?? {}) as Record<string, unknown>;
  for (const [spec, targetRaw] of Object.entries(imports)) {
    if (!spec.startsWith("#")) continue;
    const target =
      typeof targetRaw === "string"
        ? targetRaw
        : typeof (targetRaw as { default?: string })?.default === "string"
          ? (targetRaw as { default: string }).default
          : null;
    if (!target) continue;
    const star = spec.indexOf("*");
    patterns.push({
      prefix: star >= 0 ? spec.slice(0, star) : spec,
      suffix: star >= 0 ? spec.slice(star + 1) : "",
      targets: [path.resolve(projectRoot, target.replace("*", ""))],
    });
  }

  const config: AliasConfig | null =
    patterns.length > 0 || baseDir ? { baseDir, patterns } : null;
  aliasCache.set(projectRoot, config);
  return config;
}

async function probeWithExtensions(
  absBase: string,
  exts: string[],
  projectRoot: string,
): Promise<string | null> {
  const candidates = [
    absBase,
    ...exts.map((e) => absBase + e),
    ...exts.map((e) => path.join(absBase, "index" + e)),
  ];
  for (const abs of candidates) {
    try {
      const stat = await fs.stat(abs);
      if (stat.isFile()) {
        return path.relative(projectRoot, abs).replace(/\\/g, "/");
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Resolve a non-relative import via tsconfig paths/baseUrl + package imports. */
async function resolveAliasImport(
  importPath: string,
  exts: string[],
  projectRoot: string,
): Promise<string | null> {
  const config = await loadAliasConfig(projectRoot);
  if (!config) return null;

  // `paths` / `imports` patterns (longest prefix first for specificity).
  const sorted = [...config.patterns].sort(
    (a, b) => b.prefix.length - a.prefix.length,
  );
  for (const { prefix, suffix, targets } of sorted) {
    if (!importPath.startsWith(prefix)) continue;
    if (suffix && !importPath.endsWith(suffix)) continue;
    const middle = importPath.slice(
      prefix.length,
      suffix ? importPath.length - suffix.length : undefined,
    );
    for (const targetBase of targets) {
      const absBase = path.join(targetBase, middle);
      const resolved = await probeWithExtensions(absBase, exts, projectRoot);
      if (resolved) return resolved;
    }
  }

  // Bare baseUrl resolution (no matching path mapping).
  if (config.baseDir) {
    const resolved = await probeWithExtensions(
      path.join(config.baseDir, importPath),
      exts,
      projectRoot,
    );
    if (resolved) return resolved;
  }
  return null;
}

export async function resolveRelativeImport(
  importPath: string,
  fromRelFile: string,
  projectRoot: string,
): Promise<string | null> {
  const exts = resolveExtensions(fromRelFile);

  if (importPath.startsWith(".")) {
    const fromDir = path.dirname(path.join(projectRoot, fromRelFile));
    const base = path.normalize(path.join(fromDir, importPath)).replace(/\\/g, "/");

    const candidates = [
      ...exts.map((ext) => base + ext),
      ...exts.map((ext) => path.join(base, "index" + ext)),
      ...exts.map((ext) => path.join(base, "__init__" + ext)),
    ];

    for (const abs of candidates) {
      try {
        await fs.access(abs);
        const rel = path.relative(projectRoot, abs).replace(/\\/g, "/");
        return rel;
      } catch {
        /* try next */
      }
    }
    return null;
  }

  if (path.extname(fromRelFile).toLowerCase() === ".py") {
    const dotted = importPath.replace(/\./g, "/");
    const candidates = [
      path.join(projectRoot, `${dotted}.py`),
      path.join(projectRoot, dotted, "__init__.py"),
      path.join(projectRoot, "src", `${dotted}.py`),
      path.join(projectRoot, "src", dotted, "__init__.py"),
    ];
    for (const abs of candidates) {
      try {
        await fs.access(abs);
        return path.relative(projectRoot, abs).replace(/\\/g, "/");
      } catch {
        /* try next */
      }
    }
    return null;
  }

  // v12 Tier 6 #1: non-relative TS/JS import → tsconfig paths/baseUrl +
  // package.json imports. This recovers the cross-module edges that alias
  // imports (`@/lib/x`, `#internal/y`) previously dropped silently.
  if (exts === TS_RESOLVE) {
    return resolveAliasImport(importPath, exts, projectRoot);
  }

  return null;
}

/** Test seam: drop the per-root alias-config cache. */
export function clearAliasConfigCache(): void {
  aliasCache.clear();
}

export function nodeIdForFileLine(relPath: string, line: number, suffix: string): string {
  return createHash("sha256")
    .update(`node:${relPath}:${line}:${suffix}`)
    .digest("hex")
    .slice(0, 16);
}
