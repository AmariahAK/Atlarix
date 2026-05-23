/**
 * Pass 7: Skills wired to ToolRegistry.
 *
 * Previously installed skills could only be loaded via IPC for the renderer.
 * The model had no tool to read them. We removed the dead pre-injection
 * (chat_stream_handlers.ts `if (false) installedSkills`) and expose two tools:
 *
 *   - get_active_skills    — load full SKILL.md content for installed skills
 *   - list_installed_skills — lightweight registry listing (id, name, tags, scope)
 */

import { ToolRegistry, ToolCategory } from "./registry";
import { db } from "../../db";
import { installedSkills } from "../../db/schema";
import { and, eq, or } from "drizzle-orm";
import { loadInstalledSkillsForSession } from "../skills/installed-skills";
import { loadBuiltinGuides } from "../skills/builtin-guides";

function safeParseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((s) => String(s)) : [];
  } catch {
    return [];
  }
}

ToolRegistry.register({
  name: "get_active_skills",
  category: ToolCategory.MEMORY,
  cost: 1,
  requiresWorkspace: false,
  isCore: false,
  isReadOnly: true,
  allowInAskMode: true,
  description:
    "Get the SKILL.md content for skills installed in this session (workspace skills first, then global), plus built-in guides when filtered. Call this when you need guidance on language patterns, framework conventions, workflow automation, or **inline visuals** (tables, charts, mermaid, markmap). Use filter `visual` or `artifact` for the Visual Artifacts built-in guide.",
  parameters: {
    type: "object",
    properties: {
      filter: {
        type: "string",
        description: "Optional substring to filter by skill name or tag (e.g. 'react', 'visual', 'artifact', 'mermaid').",
      },
    },
  },
  handler: async (args: { filter?: string; workspace?: string }) => {
    try {
      const filter = args.filter?.trim();
      const builtinGuides = filter ? loadBuiltinGuides(filter) : [];
      const builtinSkills = builtinGuides.map((g) => ({
        id: `builtin:${g.id}`,
        name: g.name,
        scope: "builtin" as const,
        content: g.content,
      }));

      const all = await loadInstalledSkillsForSession({
        workspacePath: args.workspace ?? undefined,
        maxTotalSkills: 10,
        maxCharsPerSkill: 12_000,
        maxTotalChars: 40_000,
      });

      let filtered = all;
      if (filter) {
        const f = filter.toLowerCase();
        filtered = all.filter((s) => s.name.toLowerCase().includes(f) || s.id.toLowerCase().includes(f));
      }

      const merged = [...builtinSkills, ...filtered];

      if (merged.length === 0) {
        return {
          skills: [],
          message: filter
            ? `No installed or built-in skills matched filter "${filter}". Use list_installed_skills to see what is available.`
            : "No skills installed. Browse and install from Settings → Skills.",
        };
      }

      return {
        skills: merged.map((s) => ({
          id: s.id,
          name: s.name,
          scope: s.scope,
          content: s.content,
        })),
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },
});

ToolRegistry.register({
  name: "list_installed_skills",
  category: ToolCategory.MEMORY,
  cost: 1,
  requiresWorkspace: false,
  isCore: false,
  isReadOnly: true,
  allowInAskMode: true,
  description:
    "List skills currently installed in this session (global + workspace-scoped). Returns lightweight metadata — id, name, tags, compatible modes, scope — without full SKILL.md content. Use get_active_skills to fetch the actual content.",
  parameters: { type: "object", properties: {} },
  handler: async (args: { workspace?: string }) => {
    try {
      const wsPath = args.workspace?.trim() || null;
      const where = wsPath
        ? or(
            eq(installedSkills.scope, "global"),
            and(eq(installedSkills.scope, "workspace"), eq(installedSkills.workspacePath, wsPath))
          )
        : eq(installedSkills.scope, "global");

      const rows = await db.select().from(installedSkills).where(where);
      const skills = rows.map((r) => ({
        id: r.id,
        name: r.name,
        scope: r.scope,
        version: r.version,
        author: r.author,
        description: r.description,
        tags: safeParseJsonArray(r.tags),
        compatibleModes: safeParseJsonArray(r.compatibleModes),
      }));

      if (skills.length === 0) {
        return {
          skills: [],
          message: "No skills installed. Browse and install from Settings → Skills.",
        };
      }
      return { skills };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },
});
