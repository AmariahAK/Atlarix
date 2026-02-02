/**
 * Python extractor - project → AppMap (entry points, data sources)
 * Supports FastAPI, Flask, Django. Scans routes and deps from pyproject.toml / requirements.txt.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type {
  AppMap,
  AppMapEntryPoint,
  AppMapDataSource,
  AppMapConditional,
} from "../app_map_types";

// FastAPI: @app.get("/path"), @router.post("/path")
const FASTAPI_ROUTE = /@(?:app|router)\s*\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/gi;
// Flask: @app.route("/path"), @bp.route("/path", methods=["GET"])
const FLASK_ROUTE = /@(?:app|bp|[\w]+)\s*\.route\s*\(\s*["']([^"']+)["']/gi;
// Django urlpatterns: path("url/", view), re_path(...)
const DJANGO_PATH = /path\s*\(\s*["']([^"']+)["']/gi;

/** Package name (as in requirements/pyproject) → data source type/name */
const DATA_SOURCE_DEPS: Record<string, { type: AppMapDataSource["type"]; name: string }> = {
  sqlalchemy: { type: "database", name: "SQLAlchemy" },
  psycopg2: { type: "database", name: "PostgreSQL" },
  "psycopg2-binary": { type: "database", name: "PostgreSQL" },
  pymysql: { type: "database", name: "MySQL" },
  pymongo: { type: "database", name: "MongoDB" },
  redis: { type: "cache", name: "Redis" },
  django: { type: "database", name: "Django ORM" },
  fastapi: { type: "api", name: "HTTP" },
  flask: { type: "api", name: "HTTP" },
};

const EXCLUDE_DIRS = new Set([
  ".git",
  "venv",
  ".venv",
  "env",
  "__pycache__",
  "node_modules",
  ".mypy_cache",
  ".pytest_cache",
  "dist",
  "build",
]);

async function findPythonFiles(dir: string, base: string): Promise<string[]> {
  const files: string[] = [];
  let entries: { name: string }[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full);
    if (e.isDirectory()) {
      if (!EXCLUDE_DIRS.has(e.name) && !rel.includes("venv") && !rel.includes("__pycache__")) {
        files.push(...(await findPythonFiles(full, base)));
      }
    } else if (/\.py$/.test(e.name)) {
      files.push(full);
    }
  }
  return files;
}

function extractRoutesFromContent(
  content: string,
  filePath: string,
  framework: "fastapi" | "flask" | "django"
): AppMapEntryPoint[] {
  const entries: AppMapEntryPoint[] = [];
  const seen = new Set<string>();

  if (framework === "fastapi") {
    let m: RegExpExecArray | null;
    FASTAPI_ROUTE.lastIndex = 0;
    while ((m = FASTAPI_ROUTE.exec(content)) !== null) {
      const method = (m[1] || "get").toUpperCase();
      const routePath = m[2] || "/";
      const key = `${method}:${routePath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        id: `ep-${entries.length + 1}-${method}-${routePath.replace(/\//g, "-").replace(/\s/g, "")}`,
        type: "http",
        method,
        path: routePath,
        name: `${method} ${routePath}`,
        handlerFile: filePath,
      });
    }
  }

  if (framework === "flask") {
    let m: RegExpExecArray | null;
    FLASK_ROUTE.lastIndex = 0;
    while ((m = FLASK_ROUTE.exec(content)) !== null) {
      const routePath = m[1] || "/";
      const key = `GET:${routePath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        id: `ep-${entries.length + 1}-${routePath.replace(/\//g, "-").replace(/\s/g, "")}`,
        type: "http",
        method: "GET",
        path: routePath,
        name: `GET ${routePath}`,
        handlerFile: filePath,
      });
    }
  }

  if (framework === "django") {
    let m: RegExpExecArray | null;
    DJANGO_PATH.lastIndex = 0;
    while ((m = DJANGO_PATH.exec(content)) !== null) {
      const routePath = m[1] || "/";
      const key = routePath;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        id: `ep-${entries.length + 1}-${routePath.replace(/\//g, "-").replace(/\s/g, "")}`,
        type: "http",
        method: "GET",
        path: routePath,
        name: routePath,
        handlerFile: filePath,
      });
    }
  }

  return entries;
}

/** Heuristic: find if/else branches in Python and return conditionals + synthetic entry points. */
function extractConditionalsFromContent(
  content: string,
  filePath: string,
  baseIndex: number
): { conditionals: AppMapConditional[]; syntheticEntries: AppMapEntryPoint[] } {
  const conditionals: AppMapConditional[] = [];
  const syntheticEntries: AppMapEntryPoint[] = [];
  const ifRegex = /if\s+([^:]+):/g;
  const elseRegex = /^\s*else\s*:/gm;
  const ifRanges: { condition: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = ifRegex.exec(content)) !== null) {
    ifRanges.push({ condition: m[1].trim().slice(0, 80) });
  }
  const elseCount = (content.match(elseRegex) ?? []).length;
  const n = Math.min(ifRanges.length, elseCount);
  for (let i = 0; i < n; i++) {
    const condId = `cond-${baseIndex + i + 1}`;
    const thenId = `ep-${condId}-then`;
    const elseId = `ep-${condId}-else`;
    conditionals.push({
      id: condId,
      label: `branch: ${ifRanges[i].condition}`,
      condition: ifRanges[i].condition,
      thenNode: thenId,
      elseNode: elseId,
    });
    syntheticEntries.push({ id: thenId, type: "http", name: "then", handlerFile: filePath });
    syntheticEntries.push({ id: elseId, type: "http", name: "else", handlerFile: filePath });
  }
  return { conditionals, syntheticEntries };
}

async function detectPythonFramework(projectPath: string): Promise<"fastapi" | "flask" | "django" | null> {
  const pyproject = path.join(projectPath, "pyproject.toml");
  const requirements = path.join(projectPath, "requirements.txt");
  try {
    if (await fs.stat(pyproject).then(() => true).catch(() => false)) {
      const content = await fs.readFile(pyproject, "utf8");
      if (content.includes("fastapi")) return "fastapi";
      if (content.includes("flask")) return "flask";
      if (content.includes("django")) return "django";
    }
  } catch {
    //
  }
  try {
    if (await fs.stat(requirements).then(() => true).catch(() => false)) {
      const content = await fs.readFile(requirements, "utf8");
      if (content.toLowerCase().includes("fastapi")) return "fastapi";
      if (content.toLowerCase().includes("flask")) return "flask";
      if (content.toLowerCase().includes("django")) return "django";
    }
  } catch {
    //
  }
  return null;
}

export async function extractAppMapFromPython(projectPath: string): Promise<AppMap> {
  const entryPoints: AppMapEntryPoint[] = [];
  const dataSourceIds = new Set<string>();
  const dataSources: AppMapDataSource[] = [];
  const conditionals: AppMapConditional[] = [];
  let conditionalIndex = 0;

  const framework = await detectPythonFramework(projectPath);

  const depFiles = [
    path.join(projectPath, "pyproject.toml"),
    path.join(projectPath, "requirements.txt"),
  ];
  for (const depFile of depFiles) {
    try {
      const content = await fs.readFile(depFile, "utf8");
      const lower = content.toLowerCase();
      for (const [pkg, info] of Object.entries(DATA_SOURCE_DEPS)) {
        if (dataSourceIds.has(pkg)) continue;
        if (lower.includes(pkg)) {
          dataSourceIds.add(pkg);
          dataSources.push({
            id: `ds-${pkg.replace(/[^a-z0-9]/gi, "-")}`,
            type: info.type,
            name: info.name,
          });
        }
      }
    } catch {
      //
    }
  }

  if (framework) {
    const pyFiles = await findPythonFiles(projectPath, projectPath);
    for (const file of pyFiles.slice(0, 200)) {
      try {
        const content = await fs.readFile(file, "utf8");
        const rel = path.relative(projectPath, file);
        const routes = extractRoutesFromContent(content, rel, framework);
        for (const ep of routes) {
          entryPoints.push(ep);
        }
        const { conditionals: fileCond, syntheticEntries: fileSyn } = extractConditionalsFromContent(
          content,
          rel,
          conditionalIndex
        );
        if (fileCond.length > 0) {
          conditionals.push(...fileCond);
          entryPoints.push(...fileSyn);
          conditionalIndex += fileCond.length;
        }
      } catch {
        //
      }
    }
  }

  if (entryPoints.length === 0 && dataSources.length === 0) {
    entryPoints.push({
      id: "ep-app",
      type: "http",
      method: "GET",
      path: "/",
      name: framework ? `${framework} app` : "Python app",
    });
  }

  return {
    runtime: "python",
    entryPoints,
    dataSources,
    ...(conditionals.length > 0 && { conditionals }),
  };
}
