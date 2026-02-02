/**
 * Codegen - AppMap → project files (per language)
 * Used when user clicks "Generate Code" / "Apply" from Atlaflow.
 * Full support: Node, Bun, Python. Other runtimes return a clear "not implemented" message.
 */

import type { AppMap } from "../app_map_types";
import { applyAppMapToNode } from "./node";
import { applyAppMapToPython } from "./python";

export { applyAppMapToNode } from "./node";
export { applyAppMapToPython } from "./python";

export interface CodegenResult {
  success: boolean;
  filesCreated: string[];
  filesUpdated: string[];
  message: string;
  error?: string;
}

/**
 * Apply AppMap to project: create/update files for routes, data sources, etc.
 * Dispatches by appMap.runtime. Only Node/Bun and Python have codegen; others return not implemented.
 */
export async function applyAppMap(
  projectPath: string,
  appMap: AppMap
): Promise<CodegenResult> {
  try {
    if (appMap.runtime === "node" || appMap.runtime === "bun") {
      return await applyAppMapToNode(projectPath, appMap);
    }
    if (appMap.runtime === "python") {
      return await applyAppMapToPython(projectPath, appMap);
    }
    return {
      success: false,
      filesCreated: [],
      filesUpdated: [],
      message: `Codegen for "${appMap.runtime}" is not implemented yet. Supported: Node/Bun, Python.`,
      error: "Unsupported runtime",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return {
      success: false,
      filesCreated: [],
      filesUpdated: [],
      message: `Codegen failed: ${message}`,
      error: message,
    };
  }
}
