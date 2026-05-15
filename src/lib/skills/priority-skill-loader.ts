/**
 * Workforce Feature: repo-scoped priority skills in `.atlarix/skills/`.
 *
 * Loads SKILL.md files committed inside the workspace. Files with
 * `priority: true` in their frontmatter are injected ahead of marketplace and
 * built-in mode skills. The `priority: true` flag is only honoured for
 * Workforce accounts; Free/Pro users can keep the folder (it still loads as
 * regular local skills) but the priority flag is forced to false at load time.
 *
 * Pass 8 (Workforce features). No external frontmatter parser dep — a tiny
 * inline YAML-frontmatter parser handles the six fields we need.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import log from "electron-log";

const logger = log.scope("priority-skill-loader");

const SKILLS_DIR_REL = ".atlarix/skills";
const ALL_MODES = ["ask", "build", "plan", "debug", "review"] as const;

export interface PrioritySkill {
  name: string;
  description: string;
  tags: string[];
  modes: string[];
  priority: boolean;
  version: string;
  content: string;
  filename: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline YAML-frontmatter parser
// ─────────────────────────────────────────────────────────────────────────────

interface ParsedFrontmatter {
  data: Record<string, unknown>;
  content: string;
}

/**
 * Minimal frontmatter parser. Recognises the leading `---\n…\n---` block and
 * supports the small subset of YAML used by SKILL.md files:
 *   - string scalars (`key: value` / `key: "value"` / `key: 'value'`)
 *   - booleans (`true` / `false`)
 *   - inline JSON arrays (`key: ["a", "b"]`)
 *   - block list arrays (`key:\n  - a\n  - b\n`)
 */
function parseFrontmatter(raw: string): ParsedFrontmatter {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { data: {}, content: raw };
  }

  const yaml = match[1];
  const content = match[2] ?? "";
  const data: Record<string, unknown> = {};

  const lines = yaml.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) {
      i++;
      continue;
    }

    const kv = line.match(/^([A-Za-z0-9_\-]+)\s*:\s*(.*)$/);
    if (!kv) {
      i++;
      continue;
    }

    const key = kv[1];
    const rest = kv[2] ?? "";

    // Block list: `key:` followed by `  - item` lines.
    if (rest.trim() === "") {
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
        const item = lines[j].replace(/^\s*-\s+/, "").trim();
        items.push(stripQuotes(item));
        j++;
      }
      if (items.length > 0) {
        data[key] = items;
        i = j;
        continue;
      }
      data[key] = "";
      i++;
      continue;
    }

    // Inline JSON array: `key: ["a", "b"]`
    if (/^\[/.test(rest.trim())) {
      try {
        const arr = JSON.parse(rest.trim().replace(/'/g, '"'));
        if (Array.isArray(arr)) {
          data[key] = arr.map((v) => String(v));
          i++;
          continue;
        }
      } catch {
        // Fall through to scalar handling.
      }
    }

    // Booleans
    if (/^(true|false)$/i.test(rest.trim())) {
      data[key] = rest.trim().toLowerCase() === "true";
      i++;
      continue;
    }

    // Scalar string
    data[key] = stripQuotes(rest.trim());
    i++;
  }

  return { data, content };
}

function stripQuotes(s: string): string {
  if (
    (s.startsWith("\"") && s.endsWith("\"")) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Loader
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WORKFORCE: Load priority skills from `.atlarix/skills/` in the workspace root.
 *
 * Only top-level `.md` / `.txt` files are read. Subdirectories are skipped to
 * avoid colliding with the per-skill `agents/builder.md` override layout used
 * by `loadSkill()` in `skill-loader.ts`.
 *
 * The `priority: true` flag is enforced only for Workforce accounts.
 */
export async function loadPrioritySkillsForWorkspace(
  workspacePath: string,
  isWorkforce: boolean,
): Promise<PrioritySkill[]> {
  if (!workspacePath) return [];

  const skillsDir = path.join(workspacePath, SKILLS_DIR_REL);

  let entries: import("fs").Dirent[];
  try {
    entries = (await fs.readdir(skillsDir, { withFileTypes: true })) as unknown as import("fs").Dirent[];
  } catch {
    return []; // No .atlarix/skills/ — normal, not an error.
  }

  const skills: PrioritySkill[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const lower = entry.name.toLowerCase();
    if (!lower.endsWith(".md") && !lower.endsWith(".txt")) continue;

    const filePath = path.join(skillsDir, entry.name);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const { data, content } = parseFrontmatter(raw);

      const tags = Array.isArray(data.tags)
        ? (data.tags as unknown[]).map((t) => String(t))
        : [];
      const modes = Array.isArray(data.modes)
        ? (data.modes as unknown[]).map((m) => String(m))
        : [...ALL_MODES];

      const skill: PrioritySkill = {
        name:
          typeof data.name === "string" && data.name.trim()
            ? data.name.trim()
            : entry.name.replace(/\.(md|txt)$/i, ""),
        description: typeof data.description === "string" ? data.description : "",
        tags,
        modes,
        priority: isWorkforce ? data.priority === true : false,
        version: typeof data.version === "string" && data.version.trim()
          ? data.version.trim()
          : "1.0.0",
        content: content.trim(),
        filename: entry.name,
      };

      skills.push(skill);
    } catch (err) {
      logger.warn(`[priority-skills] Failed to parse ${entry.name}:`, err);
    }
  }

  // Priority skills first, then regular local skills (stable order otherwise).
  return skills.sort((a, b) => {
    if (a.priority && !b.priority) return -1;
    if (!a.priority && b.priority) return 1;
    return a.filename.localeCompare(b.filename);
  });
}

/**
 * Format priority skills for system-prompt injection. Two sections:
 *   ## Repo Skills (Priority — always apply these first)
 *   ## Repo Skills (Local)
 *
 * Only skills whose `modes` include `currentMode` (or `*`) are emitted.
 */
export function formatPrioritySkillsForPrompt(
  skills: PrioritySkill[],
  currentMode: string,
): string {
  if (!skills.length) return "";

  const applicable = skills.filter(
    (s) => s.modes.includes(currentMode) || s.modes.includes("*"),
  );
  if (!applicable.length) return "";

  const priorityOnes = applicable.filter((s) => s.priority);
  const localOnes = applicable.filter((s) => !s.priority);

  const parts: string[] = [];

  if (priorityOnes.length > 0) {
    parts.push("## Repo Skills (Priority — always apply these first)\n");
    for (const s of priorityOnes) {
      parts.push(`### ${s.name}`);
      if (s.content) parts.push(s.content);
      parts.push("");
    }
  }

  if (localOnes.length > 0) {
    parts.push("## Repo Skills (Local)\n");
    for (const s of localOnes) {
      parts.push(`### ${s.name}`);
      if (s.content) parts.push(s.content);
      parts.push("");
    }
  }

  return parts.join("\n").trim();
}

export const PRIORITY_SKILLS_DIR_REL = SKILLS_DIR_REL;
