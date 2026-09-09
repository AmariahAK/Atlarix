/**
 * Workspace skills: READ ONLY.
 *
 * The in-app skills marketplace was deleted in v14.45. It fetched a remote registry
 * index, downloaded manifest files into `.atlarix/skills/<skillId>/`, and tracked the
 * lot in an `installed_skills` table. All of it is gone — the registry fetch, install,
 * uninstall, the installed/orphan listings, and the table.
 *
 * WHY, because it reads like a capability regression and is not one. Users research a
 * skill at the moment they need it, or ask the model to write one; a curated in-app store
 * competed with that and earned nothing. The reasoning generalises and is the part worth
 * keeping: a skill is inert text, whereas an MCP server is a live connection holding
 * credentials with remote side effects. Curation and management are worth building where a
 * mistake has consequences — which is the MCP side, not this one.
 *
 * What remains is the feature that was always the real one: `.atlarix/skills/*.md` files
 * a user writes or drops into their own repo. This module lets the app LIST them and READ
 * one. Nothing here writes to disk or to the database.
 */
import type { IpcMainInvokeEvent } from "electron";
import log from "electron-log";
import { eq } from "drizzle-orm";

import { db } from "../../db";
import { apps } from "../../db/schema";
import { createLoggedHandler } from "./safe_handle";
import { loadPrioritySkillsForWorkspace } from "../../lib/skills/priority-skill-loader";
import { getAtlarixAppPath } from "../../paths/paths";

const logger = log.scope("skills_handlers");
const handle = createLoggedHandler(logger);

/**
 * Resolve a workspace id to the skills the loader can see, or null.
 *
 * Shared by both handlers so the list and the read can never disagree about which
 * files exist — which is also what makes the read safe without any path handling of
 * its own. See `skills:read-repo-skill`.
 */
async function loadSkillsForWorkspaceId(workspaceId: unknown) {
  if (typeof workspaceId !== "number" || workspaceId <= 0) return null;

  const [appRow] = await db
    .select()
    .from(apps)
    .where(eq(apps.id, workspaceId))
    .limit(1);
  if (!appRow) return null;

  // Team tier removed — repo skill priority (was Team-only) is disabled.
  return loadPrioritySkillsForWorkspace(getAtlarixAppPath(appRow.path), false);
}

export function registerSkillsHandlers() {
  handle(
    "skills:list-repo-skills",
    async (
      _event: IpcMainInvokeEvent,
      params?: { workspaceId?: number },
    ): Promise<{
      skills: Array<{
        name: string;
        description: string;
        tags: string[];
        modes: string[];
        priority: boolean;
        version: string;
        filename: string;
      }>;
      isWorkforce: boolean;
    }> => {
      // Team tier removed — repo skill priority (was Team-only) is disabled.
      const isWorkforce = false;
      const loaded = await loadSkillsForWorkspaceId(params?.workspaceId);
      if (!loaded) return { skills: [], isWorkforce };

      // Metadata only. The bodies are deliberately NOT sent here: a workspace can
      // hold any number of skills, and shipping every body to render a list is the
      // same mistake as putting them in the prompt (`DESIGN_NOTES.md` — skills are an
      // index, not a payload). `skills:read-repo-skill` fetches one on demand.
      const skills = loaded.map((s) => ({
        name: s.name,
        description: s.description,
        tags: s.tags,
        modes: s.modes,
        priority: s.priority,
        version: s.version,
        filename: s.filename,
      }));
      return { skills, isWorkforce };
    },
  );

  handle(
    "skills:read-repo-skill",
    async (
      _event: IpcMainInvokeEvent,
      params?: { workspaceId?: number; filename?: string },
    ): Promise<{ content: string } | null> => {
      const filename = params?.filename?.trim();
      if (!filename) return null;

      const loaded = await loadSkillsForWorkspaceId(params?.workspaceId);
      if (!loaded) return null;

      /**
       * SELECT FROM WHAT THE LOADER ENUMERATED — never join a path from this input.
       *
       * `filename` arrives from the renderer, so building
       * `<workspace>/.atlarix/skills/<filename>` would be a traversal surface needing a
       * guard, and `.atlarix/**` has already produced one hole in this codebase. Matching
       * against the list the loader already produced removes the surface instead of
       * guarding it: a name that is not a skill in this workspace simply is not found.
       *
       * The loader also already holds the body (`PrioritySkill.content`), so this costs
       * no extra file I/O — the list handler just drops it.
       */
      const match = loaded.find((s) => s.filename === filename);
      if (!match) {
        logger.warn(
          `skills:read-repo-skill: "${filename}" is not a skill in workspace ${params?.workspaceId}`,
        );
        return null;
      }
      return { content: match.content };
    },
  );

  // DELETED: `skills:get-active-for-session`. It was the body of the v13-era
  // `get_active_skills` tool — read every cached SKILL.md and return the lot —
  // and it outlived that tool with no renderer caller at all. Skills reach the
  // model as an index now (skill-index.ts) and their bodies via read_file.
}
