/**
 * Load built-in and workspace-overridden agent/mode skill markdown (main process).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { app } from "electron";

const skillCache = new Map<string, string>();

function resolveBuiltinSkillsRoot(): string {
  try {
    if (app.isPackaged) {
      // packagerConfig.extraResource copies `src/skills` → resources/skills (basename)
      return path.join(process.resourcesPath, "skills");
    }
    return path.join(app.getAppPath(), "src", "skills");
  } catch {
    return path.join(process.cwd(), "src", "skills");
  }
}

export function clearSkillCache(): void {
  skillCache.clear();
}

/**
 * @param skillName e.g. `agents/builder` or `modes/ask-mode` (no `.md`)
 */
export async function loadSkill(
  skillName: string,
  workspacePath?: string,
): Promise<string> {
  const safeName = skillName.replace(/^\/+|\.md$/g, "").replace(/\.\./g, "");
  if (!safeName) return "";

  if (workspacePath) {
    const overridePath = path.join(
      workspacePath,
      ".atlarix",
      "skills",
      ...safeName.split("/"),
    );
    const overrideMd = `${overridePath}.md`;
    try {
      const content = await fs.readFile(overrideMd, "utf8");
      return content;
    } catch {
      // no override
    }
  }

  const cacheKey = `${workspacePath ?? ""}:${safeName}`;
  const cached = skillCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const builtInPath = path.join(resolveBuiltinSkillsRoot(), ...safeName.split("/")) + ".md";
  const content = await fs.readFile(builtInPath, "utf8");
  skillCache.set(cacheKey, content);
  return content;
}
