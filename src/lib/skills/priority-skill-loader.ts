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

/**
 * Normalize a mode token for matching. Skills (local frontmatter + the
 * marketplace `compatibleModes`) are authored with the DISPLAY names — Title
 * case, and "Explore" after the 2026-07 ask→explore *display* rename — while the
 * runtime WorkMode value is still the lowercase enum `"ask"` (schemas.ts, kept
 * for back-compat). Lowercase both sides and fold the "explore" label onto its
 * enum value so a `compatibleModes: [Explore]` skill matches `currentMode="ask"`.
 */
export function normalizeMode(mode: string): string {
  const m = mode.trim().toLowerCase();
  return m === "explore" ? "ask" : m;
}

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

export interface ParsedFrontmatter {
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
export function parseFrontmatter(raw: string): ParsedFrontmatter {
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

    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
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

    // Inline flow sequence: `key: ["a", "b"]`, `key: ['a']`, or — valid YAML and
    // what people actually write — `key: [Build, Review]` with bare scalars.
    //
    // This used to be JSON.parse only, so an unquoted `compatibleModes: [Debug]`
    // threw, fell through to scalar, and left `modes` unset — which the loader
    // reads as "applies in EVERY mode". The skill's own restriction silently
    // inverted into the opposite of what its author wrote.
    const inline = rest.trim();
    if (inline.startsWith("[") && inline.endsWith("]")) {
      const items = inline
        .slice(1, -1)
        .split(",")
        .map((v) => stripQuotes(v.trim()))
        .filter((v) => v.length > 0);
      data[key] = items;
      i++;
      continue;
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
    (s.startsWith('"') && s.endsWith('"')) ||
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
    entries = (await fs.readdir(skillsDir, {
      withFileTypes: true,
    })) as unknown as import("fs").Dirent[];
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
      // Accept both `modes` (local convention) and `compatibleModes` (the
      // marketplace/community field). Absent → applies in every mode.
      const rawModes = Array.isArray(data.modes)
        ? (data.modes as unknown[])
        : Array.isArray(data.compatibleModes)
          ? (data.compatibleModes as unknown[])
          : null;
      const modes = rawModes ? rawModes.map((m) => String(m)) : [...ALL_MODES];

      const skill: PrioritySkill = {
        name:
          typeof data.name === "string" && data.name.trim()
            ? data.name.trim()
            : entry.name.replace(/\.(md|txt)$/i, ""),
        description:
          typeof data.description === "string" ? data.description : "",
        tags,
        modes,
        priority: isWorkforce ? data.priority === true : false,
        version:
          typeof data.version === "string" && data.version.trim()
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
 * Which of these skills apply in `currentMode` (frontmatter `modes` /
 * `compatibleModes`, or every mode when absent).
 *
 * DELETED alongside this: `formatPrioritySkillsForPrompt`, which emitted every
 * matching skill's FULL BODY into the prompt on every turn with no cap. Repo
 * skills are now index lines (`skill-index.ts`) and the model reads a body with
 * `read_file` when a line is relevant.
 */
export function filterSkillsForMode(
  skills: PrioritySkill[],
  currentMode: string,
): PrioritySkill[] {
  const wanted = normalizeMode(currentMode);
  return skills.filter(
    (s) =>
      s.modes.includes("*") || s.modes.some((m) => normalizeMode(m) === wanted),
  );
}
