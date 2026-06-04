/**
 * Reference projects: load/save list per workspace, build combined blueprint with [PRIMARY] / [REF: name] markers.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

const REFERENCE_PROJECTS_FILE = ".atlarix/reference-projects.json";

export async function getReferencePaths(workspacePath: string): Promise<string[]> {
  const filePath = path.join(workspacePath, REFERENCE_PROJECTS_FILE);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const data = JSON.parse(raw) as { paths?: string[] };
    return Array.isArray(data.paths) ? data.paths : [];
  } catch {
    return [];
  }
}

export async function setReferencePaths(
  workspacePath: string,
  paths: string[]
): Promise<void> {
  const filePath = path.join(workspacePath, REFERENCE_PROJECTS_FILE);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    filePath,
    JSON.stringify({ paths }, null, 2),
    "utf-8"
  );
}



