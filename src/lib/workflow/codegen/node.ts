/**
 * Node.js codegen - AppMap → project files (routes, data source setup)
 * Additive: creates atlaflow.generated.* files; does not overwrite existing app code.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { AppMap, AppMapEntryPoint, AppMapDataSource } from "../app_map_types";

const GENERATED_ROUTES_FILE = "atlaflow.generated.routes.js";
const GENERATED_DATA_FILE = "atlaflow.generated.data.js";

/** Ensure package.json has a dependency; add to dependencies if missing. */
async function ensureDependency(
  projectPath: string,
  dep: string,
  suggestedVersion: string
): Promise<boolean> {
  const pkgPath = path.join(projectPath, "package.json");
  try {
    const raw = await fs.readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> };
    const deps = pkg.dependencies ?? {};
    if (deps[dep] != null) return false; // already present
    deps[dep] = suggestedVersion;
    pkg.dependencies = deps;
    await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Generate Express-style route stubs for entry points. */
function generateRoutesContent(entryPoints: AppMapEntryPoint[]): string {
  const lines: string[] = [
    "/** Generated from Atlaflow. Require in your app: require('./atlaflow.generated.routes')(app); */",
    "module.exports = function registerAtlaflowRoutes(app) {",
  ];
  for (const ep of entryPoints) {
    if (ep.type !== "http") continue;
    const method = (ep.method ?? "get").toLowerCase();
    const routePath = ep.path ?? "/";
    const safePath = routePath.replace(/'/g, "\\'");
    lines.push(`  app.${method}('${safePath}', (req, res) => {`);
    lines.push(`    res.json({ message: '${ep.name ?? `${ep.method} ${ep.path}`}', ok: true });`);
    lines.push(`  });`);
  }
  lines.push("};");
  return lines.join("\n");
}

/** Generate a small data-source helper module (optional). */
function generateDataContent(dataSources: AppMapDataSource[]): string {
  const lines: string[] = [
    "/** Generated from Atlaflow. Optional: require('./atlaflow.generated.data') for placeholder clients. */",
    "module.exports = {",
  ];
  for (const ds of dataSources) {
    const key = ds.id.replace(/^ds-/, "").replace(/-/g, "_");
    lines.push(`  get${key.charAt(0).toUpperCase() + key.slice(1)}: () => ({ type: '${ds.type}', name: '${ds.name ?? ds.id}' }),`);
  }
  lines.push("};");
  return lines.join("\n");
}

export interface NodeCodegenResult {
  success: boolean;
  filesCreated: string[];
  filesUpdated: string[];
  message: string;
}

/**
 * Apply AppMap to a Node.js project: add generated route file and optional data file.
 * Does not modify existing app files; user must require the generated file in their app.
 */
export async function applyAppMapToNode(
  projectPath: string,
  appMap: AppMap
): Promise<NodeCodegenResult> {
  const filesCreated: string[] = [];
  const filesUpdated: string[] = [];

  const httpEntries = appMap.entryPoints.filter((ep) => ep.type === "http");
  if (httpEntries.length > 0) {
    const routesPath = path.join(projectPath, GENERATED_ROUTES_FILE);
    const content = generateRoutesContent(httpEntries);
    await fs.writeFile(routesPath, content, "utf8");
    filesCreated.push(GENERATED_ROUTES_FILE);
  }

  if (appMap.dataSources.length > 0) {
    const dataPath = path.join(projectPath, GENERATED_DATA_FILE);
    const content = generateDataContent(appMap.dataSources);
    await fs.writeFile(dataPath, content, "utf8");
    filesCreated.push(GENERATED_DATA_FILE);
  }

  // Optionally add missing deps for data sources (common ones)
  const depSuggestions: Record<string, string> = {
    express: "^4.18.0",
    pg: "^8.11.0",
    mysql2: "^3.6.0",
    mongodb: "^6.0.0",
    mongoose: "^8.0.0",
    redis: "^4.6.0",
    ioredis: "^5.3.0",
    "@prisma/client": "^5.0.0",
  };
  for (const ds of appMap.dataSources) {
    const id = ds.id.replace(/^ds-/, "").replace(/@\//g, "-");
    const pkg = Object.keys(depSuggestions).find((d) => id.includes(d) || d.includes(id));
    if (pkg && depSuggestions[pkg]) {
      const updated = await ensureDependency(projectPath, pkg, depSuggestions[pkg]);
      if (updated) filesUpdated.push("package.json");
    }
  }

  const message =
    filesCreated.length > 0
      ? `Created ${filesCreated.join(", ")}. Require atlaflow.generated.routes in your main app.`
      : "No new files (no HTTP entry points).";

  return {
    success: true,
    filesCreated,
    filesUpdated,
    message,
  };
}
