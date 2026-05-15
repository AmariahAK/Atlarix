import { app } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import log from "electron-log";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { and, eq } from "drizzle-orm";

import { db } from "../../db";
import { apps, installedSkills } from "../../db/schema";
import { createLoggedHandler } from "./safe_handle";
import { SubscriptionManager } from "../../lib/SubscriptionManager";
import { loadPrioritySkillsForWorkspace } from "../../lib/skills/priority-skill-loader";
import { getAtlarixAppPath } from "../../paths/paths";

const logger = log.scope("skills_handlers");
const handle = createLoggedHandler(logger);

const DEFAULT_REGISTRY_URL =
  "https://raw.githubusercontent.com/AmariahAK/atlarix-skills/main/index.json";

const SKILLS_GLOBAL_MAX = 5;
const SKILLS_WORKSPACE_MAX = 5;

function requirePaidSkills(): void {
  // Mirror MCP: Pro OR Workforce unlocks paid features.
  const isPro = SubscriptionManager.isPro();
  if (!isPro) {
    throw new Error("Skills are available on Pro/Workforce. Upgrade to use Skills.");
  }
}

export type SkillManifestFile = { name: string; url: string };

export type SkillManifestEntry = {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  tags: string[];
  compatibleModes: string[];
  files: SkillManifestFile[];
};

export type SkillRegistryIndex = {
  version: string;
  updatedAt?: string;
  skills: SkillManifestEntry[];
};

export type InstallSkillParams = {
  skill: SkillManifestEntry;
  scope: "global" | "workspace";
  workspacePath?: string;
};

export type UninstallSkillParams = {
  skillId: string;
  scope: "global" | "workspace";
  workspacePath?: string;
};

function assertValidInstallParams(params: InstallSkillParams): void {
  if (!params?.skill?.id?.trim()) throw new Error("Missing skill.id");
  if (!params.skill.name?.trim()) throw new Error("Missing skill.name");
  if (!params.skill.version?.trim()) throw new Error("Missing skill.version");
  if (!params.skill.author?.trim()) throw new Error("Missing skill.author");
  if (!params.skill.description?.trim()) throw new Error("Missing skill.description");
  if (!Array.isArray(params.skill.tags)) throw new Error("Invalid skill.tags");
  if (!Array.isArray(params.skill.compatibleModes))
    throw new Error("Invalid skill.compatibleModes");
  if (!Array.isArray(params.skill.files) || params.skill.files.length === 0)
    throw new Error("Invalid skill.files");
  if (params.scope === "workspace") {
    if (!params.workspacePath?.trim()) {
      throw new Error("workspacePath is required when scope === \"workspace\"");
    }
  }
}

function localDirForInstall(scope: "global" | "workspace", skillId: string, workspacePath?: string) {
  if (scope === "global") {
    return path.join(app.getPath("userData"), "skills-cache", skillId);
  }
  return path.join(workspacePath as string, ".atlarix", "skills", skillId);
}

async function fetchJsonWithTimeout(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`Registry fetch failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function countSkillsForScope(scope: "global" | "workspace", workspacePath?: string) {
  if (scope === "global") {
    const rows = await db.select().from(installedSkills).where(eq(installedSkills.scope, "global"));
    return rows.length;
  }
  const rows = await db
    .select()
    .from(installedSkills)
    .where(
      and(
        eq(installedSkills.scope, "workspace"),
        eq(installedSkills.workspacePath, workspacePath ?? ""),
      ),
    );
  return rows.length;
}

export function registerSkillsHandlers() {
  handle("skills:fetch-registry", async (_event: IpcMainInvokeEvent, registryUrl?: string) => {
    requirePaidSkills();
    const url = registryUrl?.trim() || DEFAULT_REGISTRY_URL;
    return (await fetchJsonWithTimeout(url)) as SkillRegistryIndex;
  });

  handle(
    "skills:list",
    async (
      _event: IpcMainInvokeEvent,
      params?: { scope?: "global" | "workspace" | "all"; workspacePath?: string },
    ) => {
      requirePaidSkills();
      const scope = params?.scope ?? "all";
      const wsPath = params?.workspacePath ?? undefined;

      const rows =
        scope === "global"
          ? await db.select().from(installedSkills).where(eq(installedSkills.scope, "global"))
          : scope === "workspace"
            ? await db
                .select()
                .from(installedSkills)
                .where(
                  and(
                    eq(installedSkills.scope, "workspace"),
                    eq(installedSkills.workspacePath, wsPath ?? ""),
                  ),
                )
            : await db.select().from(installedSkills);

      return rows.map((r) => ({
        ...r,
        tags: safeParseJsonArray(r.tags),
        compatibleModes: safeParseJsonArray(r.compatibleModes),
        cachedFiles: safeParseJson(r.cachedFiles, [] as Array<{ name: string; localPath: string }>),
      }));
    },
  );

  handle("skills:install", async (_event: IpcMainInvokeEvent, params: InstallSkillParams) => {
    requirePaidSkills();
    assertValidInstallParams(params);
    const { skill, scope } = params;
    const workspacePath = params.workspacePath?.trim();

    // 1. Slot limits
    if (scope === "global") {
      const globalCount = await countSkillsForScope("global");
      if (globalCount >= SKILLS_GLOBAL_MAX) {
        throw new Error(`Global skills limit reached (${SKILLS_GLOBAL_MAX}/${SKILLS_GLOBAL_MAX})`);
      }
    } else {
      const wsCount = await countSkillsForScope("workspace", workspacePath);
      if (wsCount >= SKILLS_WORKSPACE_MAX) {
        throw new Error(
          `Workspace skills limit reached (${SKILLS_WORKSPACE_MAX}/${SKILLS_WORKSPACE_MAX})`,
        );
      }
    }

    // 2. Local directory
    const localDir = localDirForInstall(scope, skill.id, workspacePath);

    // 3. Download
    try {
      await fs.rm(localDir, { recursive: true, force: true });
      await fs.mkdir(localDir, { recursive: true });

      const downloaded = [];
      for (const f of skill.files) {
        const fileUrl = f.url;
        const res = await fetch(fileUrl, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) {
          throw new Error(`Download failed for ${skill.id}/${f.name}: ${res.status} ${res.statusText}`);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        const localPath = path.join(localDir, f.name);
        await fs.mkdir(path.dirname(localPath), { recursive: true });
        await fs.writeFile(localPath, buf);
        downloaded.push({ name: f.name, localPath });
      }

      // 4. Meta
      await fs.writeFile(path.join(localDir, ".skill-meta.json"), JSON.stringify(skill, null, 2), "utf8");

      // 5. Upsert DB
      await db
        .insert(installedSkills)
        .values({
          id: skill.id,
          name: skill.name,
          version: skill.version,
          author: skill.author,
          description: skill.description,
          tags: JSON.stringify(skill.tags ?? []),
          compatibleModes: JSON.stringify(skill.compatibleModes ?? []),
          installedAt: new Date(),
          scope,
          workspacePath: scope === "workspace" ? (workspacePath as string) : null,
          cachedFiles: JSON.stringify(downloaded),
        })
        .onConflictDoUpdate({
          target: [installedSkills.id, installedSkills.scope, installedSkills.workspacePath],
          set: {
            name: skill.name,
            version: skill.version,
            author: skill.author,
            description: skill.description,
            tags: JSON.stringify(skill.tags ?? []),
            compatibleModes: JSON.stringify(skill.compatibleModes ?? []),
            installedAt: new Date(),
            cachedFiles: JSON.stringify(downloaded),
          },
        });

      return { success: true, localDir };
    } catch (e) {
      try {
        await fs.rm(localDir, { recursive: true, force: true });
      } catch {}
      throw e;
    }
  });

  handle("skills:uninstall", async (_event: IpcMainInvokeEvent, params: UninstallSkillParams) => {
    requirePaidSkills();
    const skillId = params?.skillId?.trim();
    if (!skillId) throw new Error("skillId is required");
    const scope = params.scope;
    const workspacePath = params.workspacePath?.trim();
    if (scope === "workspace" && !workspacePath) {
      throw new Error("workspacePath is required when scope === \"workspace\"");
    }

    const where =
      scope === "global"
        ? and(eq(installedSkills.id, skillId), eq(installedSkills.scope, "global"))
        : and(
            eq(installedSkills.id, skillId),
            eq(installedSkills.scope, "workspace"),
            eq(installedSkills.workspacePath, workspacePath as string),
          );

    const [row] = await db.select().from(installedSkills).where(where).limit(1);
    if (!row) return { success: true };

    const cachedFiles = safeParseJson(row.cachedFiles, [] as Array<{ name: string; localPath: string }>);
    const localDir = cachedFiles[0]?.localPath ? path.dirname(cachedFiles[0].localPath) : localDirForInstall(scope, skillId, workspacePath);

    try {
      await fs.rm(localDir, { recursive: true, force: true });
    } catch {}

    await db.delete(installedSkills).where(where);
    return { success: true };
  });

  // Workforce Feature 1: list repo-scoped priority skills from `.atlarix/skills/`.
  // No `requirePaidSkills()` gate — the folder is readable on all tiers;
  // the `priority: true` frontmatter flag is itself the gate (Workforce-only).
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
      const isWorkforce = SubscriptionManager.getEffectiveTier() === "workforce";
      const workspaceId = params?.workspaceId;
      if (typeof workspaceId !== "number" || workspaceId <= 0) {
        return { skills: [], isWorkforce };
      }

      const [appRow] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
      if (!appRow) return { skills: [], isWorkforce };

      const workspacePath = getAtlarixAppPath(appRow.path);
      const loaded = await loadPrioritySkillsForWorkspace(workspacePath, isWorkforce);
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
    "skills:get-active-for-session",
    async (_event: IpcMainInvokeEvent, params?: { workspacePath?: string }) => {
      requirePaidSkills();
      const workspacePath = params?.workspacePath?.trim();
      const [globalRows, workspaceRows] = await Promise.all([
        db.select().from(installedSkills).where(eq(installedSkills.scope, "global")),
        workspacePath
          ? db
              .select()
              .from(installedSkills)
              .where(
                and(
                  eq(installedSkills.scope, "workspace"),
                  eq(installedSkills.workspacePath, workspacePath),
                ),
              )
          : Promise.resolve([]),
      ]);

      const merged = [...workspaceRows, ...globalRows].slice(0, 10);
      const out: Array<{ id: string; name: string; content: string }> = [];
      for (const s of merged) {
        const cachedFiles = safeParseJson(s.cachedFiles, [] as Array<{ name: string; localPath: string }>);
        const skillMd = cachedFiles.find((f) => f.name.toLowerCase() === "skill.md") ?? cachedFiles.find((f) => f.name.toLowerCase().endsWith("skill.md"));
        if (!skillMd?.localPath) continue;
        try {
          const content = await fs.readFile(skillMd.localPath, "utf8");
          out.push({ id: s.id, name: s.name, content });
        } catch (e) {
          logger.warn(`Missing cached SKILL.md for ${s.id} (${s.scope})`, e);
        }
      }
      return out;
    },
  );
}

function safeParseJsonArray(raw: string | null | undefined): string[] {
  const arr = safeParseJson(raw, [] as unknown);
  return Array.isArray(arr) ? arr.map((x) => String(x)) : [];
}

function safeParseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

