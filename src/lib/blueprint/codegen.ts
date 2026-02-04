/**
 * Blueprint codegen - Generate scaffold from Blueprint delta (Phase 7)
 * Input: workspace path + new rooms/edges/envRefs.
 * Output: new stub files, merged env keys into .env.local.
 */

import * as fs from "fs";
import * as path from "path";
import type { Blueprint, BlueprintRoom, BlueprintFunction } from "../../shared/blueprint-types";
import { parseEnvFile, serializeEnvFile } from "../../ipc/utils/app_env_var_utils";

const ENV_FILE_NAME = ".env.local";

export interface CodegenDelta {
  rooms: BlueprintRoom[];
  edges: { from: string; to: string; label?: string }[];
  envRefs: string[];
}

export interface CodegenResult {
  filesCreated: string[];
  envKeysAdded: string[];
  errors: string[];
}

/**
 * Merge env refs into workspace .env.local (add missing keys with empty value).
 */
async function mergeEnvRefs(workspacePath: string, envRefs: string[]): Promise<string[]> {
  const envPath = path.join(workspacePath, ENV_FILE_NAME);
  let content = "";
  try {
    content = await fs.promises.readFile(envPath, "utf8");
  } catch {
    // File doesn't exist
  }
  const existing = parseEnvFile(content);
  const existingKeys = new Set(existing.map((e) => e.key));
  const added: string[] = [];
  for (const key of envRefs) {
    if (!key.trim()) continue;
    if (!existingKeys.has(key)) {
      existing.push({ key, value: "" });
      existingKeys.add(key);
      added.push(key);
    }
  }
  if (added.length > 0) {
    const out = serializeEnvFile(existing);
    await fs.promises.writeFile(envPath, out, "utf8");
  }
  return added;
}

/**
 * Generate stub file for a room (Node/Express style: one file per room with optional route).
 */
function generateRoomStub(room: BlueprintRoom): string {
  const hasApi = room.functions?.some((f) => f.kind === "api");
  const hasWebhook = room.functions?.some((f) => f.kind === "webhook");
  const lines: string[] = [
    `/** Generated from Blueprint: ${room.label} */`,
    "",
    ...(room.intent ? [`// ${room.intent}`, ""] : []),
  ];
  if (hasApi || hasWebhook) {
    lines.push("// TODO: Add routes or webhook handler");
    lines.push("// Example (Express): router.get('/path', handler);");
  } else {
    lines.push("// TODO: Implement module");
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Scaffold new files for delta rooms and merge env refs.
 */
export async function generateFromBlueprintDelta(
  workspacePath: string,
  delta: CodegenDelta
): Promise<CodegenResult> {
  const result: CodegenResult = { filesCreated: [], envKeysAdded: [], errors: [] };

  if (!workspacePath || !path.isAbsolute(workspacePath)) {
    result.errors.push("Workspace path must be absolute");
    return result;
  }

  try {
    await fs.promises.access(workspacePath);
  } catch {
    result.errors.push(`Workspace not found: ${workspacePath}`);
    return result;
  }

  const srcDir = path.join(workspacePath, "src");
  const routesDir = path.join(srcDir, "routes");
  const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_");

  for (const room of delta.rooms) {
    const baseName = safeId(room.id) || "module";
    const fileName = `${baseName}.ts`;
    const filePath = path.join(srcDir, fileName);
    try {
      await fs.promises.access(filePath);
      // File exists, skip (additive only)
      continue;
    } catch {
      // Create directory if needed
      await fs.promises.mkdir(srcDir, { recursive: true });
      const content = generateRoomStub(room);
      await fs.promises.writeFile(filePath, content, "utf8");
      result.filesCreated.push(path.relative(workspacePath, filePath));
    }
  }

  if (delta.envRefs?.length) {
    try {
      result.envKeysAdded = await mergeEnvRefs(workspacePath, delta.envRefs);
    } catch (e) {
      result.errors.push(`Env merge failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}

/**
 * Full Blueprint codegen (e.g. for new project): all rooms + edges + envRefs.
 */
export async function generateFromBlueprint(
  workspacePath: string,
  blueprint: Blueprint
): Promise<CodegenResult> {
  return generateFromBlueprintDelta(workspacePath, {
    rooms: blueprint.rooms ?? [],
    edges: blueprint.edges ?? [],
    envRefs: blueprint.envRefs ?? [],
  });
}
