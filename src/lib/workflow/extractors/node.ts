/**
 * Node.js extractor - project → AppMap (entry points, data sources)
 * Supports Express, Fastify, Hono. Scans routes and package.json deps.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type {
  AppMap,
  AppMapEntryPoint,
  AppMapDataSource,
  AppMapConditional,
} from "../app_map_types";

const ROUTE_REG =
  /(?:app|router|server|fastify|hono)\s*\.(get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
const ROUTE_REG_ALT = /(?:get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]\s*[,)]/gi;

const DATA_SOURCE_DEPS: Record<string, { type: AppMapDataSource["type"]; name: string }> = {
  pg: { type: "database", name: "PostgreSQL" },
  "pg-native": { type: "database", name: "PostgreSQL" },
  mysql: { type: "database", name: "MySQL" },
  mysql2: { type: "database", name: "MySQL" },
  mongodb: { type: "database", name: "MongoDB" },
  mongoose: { type: "database", name: "MongoDB" },
  redis: { type: "cache", name: "Redis" },
  ioredis: { type: "cache", name: "Redis" },
  "@supabase/supabase-js": { type: "database", name: "Supabase" },
  "prisma": { type: "database", name: "Prisma" },
  "@prisma/client": { type: "database", name: "Prisma" },
  "express": { type: "api", name: "HTTP" },
  "fastify": { type: "api", name: "HTTP" },
  "hono": { type: "api", name: "HTTP" },
};

const EXCLUDE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "__tests__",
  "test",
  "tests",
]);

async function findSourceFiles(dir: string, base: string): Promise<string[]> {
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
      if (!EXCLUDE_DIRS.has(e.name) && !rel.includes("node_modules")) {
        files.push(...(await findSourceFiles(full, base)));
      }
    } else if (/\.(js|ts|mjs|cjs|jsx|tsx)$/.test(e.name)) {
      files.push(full);
    }
  }
  return files;
}

function extractRoutesFromContent(content: string, filePath: string): AppMapEntryPoint[] {
  const entries: AppMapEntryPoint[] = [];
  const seen = new Set<string>();

  let m: RegExpExecArray | null;
  ROUTE_REG.lastIndex = 0;
  while ((m = ROUTE_REG.exec(content)) !== null) {
    const method = (m[1] || "get").toUpperCase();
    const routePath = m[2] || "/";
    const key = `${method}:${routePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      id: `ep-${entries.length + 1}-${method}-${routePath.replace(/\//g, "-")}`,
      type: "http",
      method,
      path: routePath,
      name: `${method} ${routePath}`,
      handlerFile: filePath,
    });
  }

  ROUTE_REG_ALT.lastIndex = 0;
  while ((m = ROUTE_REG_ALT.exec(content)) !== null) {
    const routePath = m[1] || "/";
    const key = `GET:${routePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      id: `ep-${entries.length + 1}-${routePath.replace(/\//g, "-")}`,
      type: "http",
      method: "GET",
      path: routePath,
      name: `GET ${routePath}`,
      handlerFile: filePath,
    });
  }

  return entries;
}

/**
 * Heuristic: find if/else branches in route-handler-like code and return conditionals + synthetic entry points.
 * Matches `if (condition) { ... } else { ... }` and creates one conditional per pair with then/else node ids.
 */
function extractConditionalsFromContent(
  content: string,
  filePath: string,
  baseIndex: number
): { conditionals: AppMapConditional[]; syntheticEntries: AppMapEntryPoint[] } {
  const conditionals: AppMapConditional[] = [];
  const syntheticEntries: AppMapEntryPoint[] = [];
  const ifRegex = /if\s*\(\s*([^)]+)\s*\)\s*\{/g;
  const elseRegex = /\}\s*else\s*\{/g;
  let ifMatch: RegExpExecArray | null;
  const ifRanges: { condition: string; start: number }[] = [];
  while ((ifMatch = ifRegex.exec(content)) !== null) {
    ifRanges.push({
      condition: ifMatch[1].trim().slice(0, 80),
      start: ifMatch.index,
    });
  }
  const elseIndices: number[] = [];
  let elseMatch: RegExpExecArray | null;
  elseRegex.lastIndex = 0;
  while ((elseMatch = elseRegex.exec(content)) !== null) {
    elseIndices.push(elseMatch.index);
  }
  for (let i = 0; i < ifRanges.length && i < elseIndices.length; i++) {
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
    syntheticEntries.push({
      id: thenId,
      type: "http",
      name: "then",
      handlerFile: filePath,
    });
    syntheticEntries.push({
      id: elseId,
      type: "http",
      name: "else",
      handlerFile: filePath,
    });
  }
  return { conditionals, syntheticEntries };
}

export async function extractAppMapFromNode(projectPath: string): Promise<AppMap> {
  const entryPoints: AppMapEntryPoint[] = [];
  const dataSourceIds = new Set<string>();
  const dataSources: AppMapDataSource[] = [];
  const conditionals: AppMapConditional[] = [];
  let conditionalIndex = 0;

  const pkgPath = path.join(projectPath, "package.json");
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try {
    const raw = await fs.readFile(pkgPath, "utf8");
    pkg = JSON.parse(raw);
  } catch {
    return { runtime: "node", entryPoints, dataSources };
  }

  const deps = { ...pkg.dependencies, ...pkg.devDependencies } ?? {};
  for (const [dep, _ver] of Object.entries(deps)) {
    const key = dep.toLowerCase();
    const info = DATA_SOURCE_DEPS[key];
    if (info && !dataSourceIds.has(key)) {
      dataSourceIds.add(key);
      dataSources.push({
        id: `ds-${key.replace(/[@/]/g, "-")}`,
        type: info.type,
        name: info.name,
      });
    }
  }

  const sourceFiles = await findSourceFiles(projectPath, projectPath);
  for (const file of sourceFiles.slice(0, 150)) {
    try {
      const content = await fs.readFile(file, "utf8");
      const rel = path.relative(projectPath, file);
      const routes = extractRoutesFromContent(content, rel);
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
      // skip
    }
  }

  if (entryPoints.length === 0 && dataSources.length === 0) {
    entryPoints.push({
      id: "ep-app",
      type: "http",
      method: "GET",
      path: "/",
      name: "App",
    });
  }

  return {
    runtime: "node",
    entryPoints,
    dataSources,
    ...(conditionals.length > 0 && { conditionals }),
  };
}
