import log from "electron-log";
import * as fs from "node:fs/promises";

import { db } from "@/db";
import { installedSkills } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  normalizeSkillWorkspacePath,
  resolveAppPath,
} from "@/paths/paths";

const logger = log.scope("installed-skills");

export type InstalledSkillContent = {
  id: string;
  name: string;
  scope: "global" | "workspace";
  workspacePath: string | null;
  content: string;
};

function safeParseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function cap(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…`;
}

function skillWorkspacePathsMatch(
  storedPath: string | null | undefined,
  lookupPath: string,
): boolean {
  if (!storedPath?.trim()) return false;
  return (
    normalizeSkillWorkspacePath(storedPath) ===
    normalizeSkillWorkspacePath(lookupPath)
  );
}

/**
 * Load installed SKILL.md contents for prompt injection.
 * Order: workspace installed → global installed.
 */
export async function loadInstalledSkillsForSession(opts: {
  workspacePath?: string | null;
  maxTotalSkills?: number;
  maxCharsPerSkill?: number;
  maxTotalChars?: number;
}): Promise<InstalledSkillContent[]> {
  const maxTotalSkills = opts.maxTotalSkills ?? 10;
  const maxCharsPerSkill = opts.maxCharsPerSkill ?? 12_000;
  const maxTotalChars = opts.maxTotalChars ?? 40_000;

  const wsPath = opts.workspacePath?.trim();
  const [workspaceRows, globalRows] = await Promise.all([
    wsPath
      ? db
          .select()
          .from(installedSkills)
          .where(eq(installedSkills.scope, "workspace"))
      : Promise.resolve([]),
    db.select().from(installedSkills).where(eq(installedSkills.scope, "global")),
  ]);

  const filteredWorkspaceRows = wsPath
    ? workspaceRows.filter((row) => skillWorkspacePathsMatch(row.workspacePath, wsPath))
    : [];

  const merged = [...filteredWorkspaceRows, ...globalRows].slice(0, maxTotalSkills);
  const out: InstalledSkillContent[] = [];
  let used = 0;

  for (const row of merged) {
    const cached = safeParseJson(row.cachedFiles, [] as Array<{ name: string; localPath: string }>);
    const skillMd =
      cached.find((f) => f.name.toLowerCase() === "skill.md") ??
      cached.find((f) => f.name.toLowerCase().endsWith("skill.md"));
    if (!skillMd?.localPath) continue;
    try {
      const raw = await fs.readFile(skillMd.localPath, "utf8");
      const clipped = cap(raw, maxCharsPerSkill);
      if (used + clipped.length > maxTotalChars) break;
      used += clipped.length;
      out.push({
        id: row.id,
        name: row.name,
        scope: row.scope as "global" | "workspace",
        workspacePath: row.workspacePath ?? null,
        content: clipped,
      });
    } catch (e) {
      logger.warn(`Missing cached SKILL.md for ${row.id} (${row.scope})`, e);
    }
  }

  return out;
}

export { normalizeSkillWorkspacePath, resolveAppPath };
