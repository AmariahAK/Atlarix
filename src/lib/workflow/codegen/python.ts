/**
 * Python codegen - AppMap → project files (routes, data source placeholders)
 * Supports FastAPI, Flask. Additive: creates atlaflow_generated.py; does not overwrite app code.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { AppMap, AppMapEntryPoint, AppMapDataSource } from "../app_map_types";

const GENERATED_FILE = "atlaflow_generated.py";

async function detectPythonFramework(projectPath: string): Promise<"fastapi" | "flask" | null> {
  for (const file of ["pyproject.toml", "requirements.txt"]) {
    try {
      const content = await fs.readFile(path.join(projectPath, file), "utf8");
      const lower = content.toLowerCase();
      if (lower.includes("fastapi")) return "fastapi";
      if (lower.includes("flask")) return "flask";
    } catch {
      //
    }
  }
  return null;
}

function generateFastAPIContent(entryPoints: AppMapEntryPoint[], dataSources: AppMapDataSource[]): string {
  const lines: string[] = [
    '"""Generated from Atlaflow. Mount in your app: from atlaflow_generated import router; app.include_router(router)"""',
    "from fastapi import APIRouter",
    "",
    "router = APIRouter()",
    "",
  ];
  for (const ep of entryPoints.filter((e) => e.type === "http")) {
    const method = (ep.method ?? "get").toLowerCase();
    const routePath = (ep.path ?? "/").replace(/'/g, "\\'");
    const name = (ep.name ?? `${ep.method} ${ep.path}`).replace(/'/g, "\\'");
    lines.push(`@router.${method}("${routePath}")`);
    lines.push(`async def ${ep.id.replace(/-/g, "_")}():`);
    lines.push(`    return {"message": "${name}", "ok": True}`);
    lines.push("");
  }
  if (dataSources.length > 0) {
    lines.push("# Data sources (placeholders)");
    for (const ds of dataSources) {
      lines.push(`# ${ds.name ?? ds.id}: ${ds.type}`);
    }
  }
  return lines.join("\n");
}

function generateFlaskContent(entryPoints: AppMapEntryPoint[], dataSources: AppMapDataSource[]): string {
  const lines: string[] = [
    '"""Generated from Atlaflow. Register in your app: from atlaflow_generated import register; register(app)"""',
    "def register(app):",
    "",
  ];
  for (const ep of entryPoints.filter((e) => e.type === "http")) {
    const routePath = (ep.path ?? "/").replace(/'/g, "\\'");
    const name = (ep.name ?? `${ep.method} ${ep.path}`).replace(/'/g, "\\'");
    lines.push(`    @app.route("${routePath}")`);
    lines.push(`    def ${ep.id.replace(/-/g, "_")}():`);
    lines.push(`        return {"message": "${name}", "ok": True}`);
    lines.push("");
  }
  if (dataSources.length > 0) {
    lines.push("    # Data sources (placeholders)");
    for (const ds of dataSources) {
      lines.push(`    # ${ds.name ?? ds.id}: ${ds.type}`);
    }
  }
  return lines.join("\n");
}

export interface PythonCodegenResult {
  success: boolean;
  filesCreated: string[];
  filesUpdated: string[];
  message: string;
}

export async function applyAppMapToPython(
  projectPath: string,
  appMap: AppMap
): Promise<PythonCodegenResult> {
  const framework = await detectPythonFramework(projectPath);
  const httpEntries = appMap.entryPoints.filter((ep) => ep.type === "http");
  const content =
    framework === "fastapi"
      ? generateFastAPIContent(httpEntries, appMap.dataSources)
      : framework === "flask"
        ? generateFlaskContent(httpEntries, appMap.dataSources)
        : [
            '"""Generated from Atlaflow. Add your routes here or use FastAPI/Flask."""',
            "# Entry points:",
            ...httpEntries.map((ep) => `# ${ep.method ?? "GET"} ${ep.path ?? "/"} - ${ep.name ?? ep.id}`),
            "",
            "# Data sources:",
            ...appMap.dataSources.map((ds) => `# ${ds.name ?? ds.id}: ${ds.type}`),
          ].join("\n");

  const outPath = path.join(projectPath, GENERATED_FILE);
  await fs.writeFile(outPath, content, "utf8");

  const message =
    framework === "fastapi"
      ? `Created ${GENERATED_FILE}. Include router in your FastAPI app.`
      : framework === "flask"
        ? `Created ${GENERATED_FILE}. Call register(app) in your Flask app.`
        : `Created ${GENERATED_FILE}. Add FastAPI/Flask and wire routes.`;

  return {
    success: true,
    filesCreated: [GENERATED_FILE],
    filesUpdated: [],
    message,
  };
}
