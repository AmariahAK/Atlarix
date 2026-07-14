/**
 * Per-turn prompt context-section loaders extracted from runStream's assembly
 * phase. Each is an independent disk/DB read that returns a ContextSection (or
 * null) and keeps its own try/catch — one failed source never blocks the
 * others. Previously nested closures over the turn locals; now free functions
 * taking an explicit params object.
 *
 * (Satellite: never imports the parent handler.)
 */

import log from "electron-log";
import type { WorkMode } from "@/lib/schemas";
import type { ChatStreamParams } from "@/ipc/ipc_types";
import type { PreflightTimer } from "@/lib/agent/preflight-timing";
import type { ContextSection } from "@/lib/context/ContextAssembler";
import { getSkillNameForMode } from "@/lib/skills/skill-registry";
import { loadSkill } from "@/lib/skills/skill-loader";
import {
  loadPrioritySkillsForWorkspace,
  formatPrioritySkillsForPrompt,
} from "@/lib/skills/priority-skill-loader";
import { readProjectInstructions } from "@/lib/project-memory";
import {
  parsePlanChecklist,
  formatPlanChecklistForPrompt,
  extractPlanChecklistTitle,
} from "@/lib/tasks/plan-checklist";

const logger = log.scope("chat_stream_handlers");

/** Shared inputs the section loaders read (the turn-assembly locals). */
export interface ContextSectionParams {
  effectiveWorkMode: WorkMode;
  preflight: PreflightTimer;
  hasWorkspace: boolean;
  appPath: string | null | undefined;
  effectiveAppId: number | null | undefined;
  req: ChatStreamParams;
}

export async function loadModeSkillSection(
  p: ContextSectionParams,
): Promise<ContextSection | null> {
  const { effectiveWorkMode, preflight, hasWorkspace, appPath } = p;
  try {
    const modeSkillName = getSkillNameForMode(effectiveWorkMode);
    const modeSkillBody = await preflight.time("mode-skill", () =>
      loadSkill(
        modeSkillName,
        hasWorkspace && appPath ? appPath : undefined,
      ),
    );
    if (!modeSkillBody.trim()) return null;
    return {
      name: "activeSkill",
      priority: -1,
      content: `[Active Skill: ${modeSkillName}]\n${modeSkillBody}`,
    };
  } catch (skillErr) {
    logger.warn("[skills] Failed to load mode skill:", skillErr);
    return null;
  }
}

// WORKFORCE Feature 1: repo-scoped priority skills from .atlarix/skills/.
// Injected ahead of the active mode skill (priority -2). The `priority: true`
// frontmatter flag only takes effect for Workforce accounts; Free/Pro still
// load files in the folder as regular local skills.
export async function loadRepoSkillsSection(
  p: ContextSectionParams,
): Promise<ContextSection | null> {
  const { effectiveWorkMode, preflight, hasWorkspace, appPath } = p;
  if (!(hasWorkspace && appPath)) return null;
  try {
    // Repo skill priority was a Team-only feature; Team was removed, so it's off.
    const prioritySkills = await preflight.time(
      "priority-skills",
      () => loadPrioritySkillsForWorkspace(appPath, false),
    );
    if (prioritySkills.length === 0) return null;
    const block = formatPrioritySkillsForPrompt(
      prioritySkills,
      effectiveWorkMode,
    );
    if (!block.trim()) return null;
    const priorityCount = prioritySkills.filter((s) => s.priority).length;
    const localCount = prioritySkills.length - priorityCount;
    logger.info(
      `[priority-skills] Injected ${priorityCount} priority + ${localCount} local skill(s) for mode "${effectiveWorkMode}"`,
    );
    return { name: "repoSkills", priority: -2, content: block };
  } catch (repoSkillErr) {
    logger.warn(
      "[priority-skills] Failed to load repo skills:",
      repoSkillErr,
    );
    return null;
  }
}

export async function loadWorkspaceCapsSection(
  p: ContextSectionParams,
): Promise<ContextSection | null> {
  const { preflight, hasWorkspace, appPath, effectiveAppId } = p;
  if (!(hasWorkspace && appPath && effectiveAppId != null)) return null;
  try {
    const {
      loadWorkspaceCapabilitiesSummary,
      formatWorkspaceCapabilitiesForPrompt,
    } = await import("@/lib/workspace/workspace-capabilities");
    const caps = await preflight.time("workspace-caps", () =>
      loadWorkspaceCapabilitiesSummary({
        workspaceId: effectiveAppId,
        workspacePath: appPath,
      }),
    );
    const capsBlock = formatWorkspaceCapabilitiesForPrompt(caps);
    if (!capsBlock.trim()) return null;
    return {
      name: "workspaceCapabilities",
      priority: -3,
      content: capsBlock,
    };
  } catch (capsErr) {
    logger.warn("[workspace-capabilities] Failed to load:", capsErr);
    return null;
  }
}

/**
 * Loads the active session plan section AND derives the per-turn recency ledger
 * block from the same fetch. Returns both — the caller assigns `taskLedgerBlock`
 * (the loader was the only writer of that turn local). Non-plan / early-return /
 * error paths return `taskLedgerBlock: null`, matching the caller's init.
 */
export async function loadActivePlanSection(
  p: ContextSectionParams,
): Promise<{ section: ContextSection | null; taskLedgerBlock: string | null }> {
  const { preflight, hasWorkspace, req } = p;
  if (
    !req.workspaceSessionId ||
    !hasWorkspace ||
    req.prompt.startsWith("Summarize from chat-id=")
  ) {
    return { section: null, taskLedgerBlock: null };
  }
  try {
    const { getLatestPlanArtifact } = await import("@/lib/plans/plan-artifacts");
    const activePlan = await preflight.time(
      "plan-artifact",
      async () =>
        (await getLatestPlanArtifact(
          req.workspaceSessionId!,
          "building",
        )) ?? (await getLatestPlanArtifact(req.workspaceSessionId!)),
    );
    if (!activePlan?.content?.trim()) return { section: null, taskLedgerBlock: null };
    // #A1: build the compact recency ledger block from the same fetch.
    let taskLedgerBlock: string | null;
    try {
      taskLedgerBlock = formatPlanChecklistForPrompt(
        parsePlanChecklist(activePlan.content),
        extractPlanChecklistTitle(activePlan.content),
      );
    } catch {
      taskLedgerBlock = null;
    }
    const snippet =
      activePlan.content.length > 3000
        ? `${activePlan.content.slice(0, 3000)}\n\n...(truncated)`
        : activePlan.content;
    return {
      section: {
        name: "activePlan",
        priority: 0.05,
        content: `Active session plan (planId: ${activePlan.id}, status: ${activePlan.planStatus}) — advance it with plan({operation: "set_status", planId: "${activePlan.id}", plan_status: "building" | "built"}). The user may edit or add to this plan while you work; before starting the next step, call plan({operation: "read", planId: "${activePlan.id}"}) to pick up any changes and honor them.\n\n${snippet}`,
      },
      taskLedgerBlock,
    };
  } catch (planCtxErr) {
    logger.warn("[plan-artifact] context inject failed:", planCtxErr);
    return { section: null, taskLedgerBlock: null };
  }
}

// Project instructions: .atlarix/atlarix.md (canonical, legacy
// auto-migrated), falling back to a repo's AGENTS.md / CLAUDE.md
// (v13.1 interop) so Atlarix is drop-in on repos configured for
// other agents.
export async function loadAtlarixMdSection(
  p: ContextSectionParams,
): Promise<ContextSection | null> {
  const { preflight, hasWorkspace, appPath } = p;
  if (!(hasWorkspace && appPath)) return null;
  try {
    const instructions = await preflight.time("atlarix-md", () =>
      readProjectInstructions(appPath),
    );
    if (!instructions) return null;
    const heading =
      instructions.source === "atlarix"
        ? "## Project memory (.atlarix/atlarix.md)"
        : instructions.source === "agents"
          ? "## Project instructions (AGENTS.md)"
          : "## Project instructions (CLAUDE.md)";
    logger.info(`Injected project instructions (${instructions.source})`);
    return {
      name: "projectMemory",
      priority: 4,
      content: `${heading}\n${instructions.content}`,
    };
  } catch (memErr) {
    logger.warn("Failed to read project instructions:", memErr);
    return null;
  }
}

// v13: .atlarix/memory.md (agent-maintained project knowledge) is
// auto-injected — the memory tool family was removed; the model
// updates the file via edit_file.
export async function loadMemoryMdSection(
  p: ContextSectionParams,
): Promise<ContextSection | null> {
  const { preflight, hasWorkspace, appPath } = p;
  if (!(hasWorkspace && appPath)) return null;
  try {
    const { readMemoryMd } = await import("@/lib/project-memory");
    const memoryMd = await preflight.time("memory-md", () =>
      readMemoryMd(appPath),
    );
    if (!memoryMd) return null;
    return {
      name: "projectKnowledge",
      priority: 3.9,
      content: `## Project knowledge (.atlarix/memory.md — update via edit_file when you learn durable facts)\n${memoryMd}`,
    };
  } catch (memErr) {
    logger.warn("Failed to read memory.md:", memErr);
    return null;
  }
}

// v13: installed (marketplace/global) skills are auto-injected —
// the get_active_skills / list_installed_skills tools were removed.
// Repo skills (.atlarix/skills/) are already injected above.
export async function loadInstalledSkillsSection(
  p: ContextSectionParams,
): Promise<ContextSection | null> {
  const { preflight, appPath } = p;
  try {
    const { loadInstalledSkillsForSession } = await import(
      "@/lib/skills/installed-skills"
    );
    const skills = await preflight.time("installed-skills", () =>
      loadInstalledSkillsForSession({
        workspacePath: appPath ?? null,
        maxTotalSkills: 10,
        maxCharsPerSkill: 6_000,
        maxTotalChars: 24_000,
      }),
    );
    if (!skills.length) return null;
    const body = skills
      .map((s) => `### Skill: ${s.name} (${s.scope})\n${s.content}`)
      .join("\n\n");
    return {
      name: "installedSkills",
      priority: 3.8,
      content: `## Installed skills\n${body}`,
    };
  } catch (skillErr) {
    logger.warn("Failed to load installed skills:", skillErr);
    return null;
  }
}
