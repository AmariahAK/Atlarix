/**
 * Resolve import paths to workspace-relative file paths (TS/JS).
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
  }

  return null;
}

export function nodeIdForFileLine(relPath: string, line: number, suffix: string): string {
  return createHash("sha256")
    .update(`node:${relPath}:${line}:${suffix}`)
    .digest("hex")
    .slice(0, 16);
}
