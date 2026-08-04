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
  buildSkillIndex,
  formatSkillIndexForPrompt,
} from "@/lib/skills/skill-index";
import { extractHeadings, readProjectInstructions } from "@/lib/project-memory";
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

/**
 * The skills INDEX — one line per skill, no bodies (v14.25.0).
 *
 * Replaces the two sections that used to paste skill BODIES into every dispatch:
 * `repoSkills` (every matching `.atlarix/skills/*.md`, uncapped) and
 * `installedSkills` (marketplace SKILL.md files, capped at 10 / 6 KB / 24 KB and
 * therefore silently clipped). Both cost the same tokens on every turn whether
 * or not the turn touched them, and both dropped content without saying so.
 *
 * Same trade the agent-memory index makes: cost scales with the NUMBER of
 * skills, the model reads a body on demand with `read_file`, and nothing is ever
 * truncated.
 */
export async function loadSkillsIndexSection(
  p: ContextSectionParams,
): Promise<ContextSection | null> {
  const { effectiveWorkMode, preflight, hasWorkspace, appPath } = p;
  try {
    const entries = await preflight.time("skills-index", () =>
      buildSkillIndex(hasWorkspace ? appPath : null, effectiveWorkMode),
    );
    const block = formatSkillIndexForPrompt(entries);
    if (!block.trim()) return null;
    logger.info(
      `[skills-index] ${entries.length} skill(s) indexed for mode "${effectiveWorkMode}" (${block.length} chars, bodies read on demand)`,
    );
    return { name: "skillsIndex", priority: -2, content: block };
  } catch (skillIndexErr) {
    logger.warn("[skills-index] Failed to build skill index:", skillIndexErr);
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

    const file =
      instructions.source === "atlarix"
        ? ".atlarix/atlarix.md"
        : instructions.source === "agents"
          ? "AGENTS.md"
          : "CLAUDE.md";
    const sizeKb = Math.max(1, Math.round(instructions.content.length / 1024));
    const headings = extractHeadings(instructions.content);

    /**
     * A POINTER, not the body (v14.23.0).
     *
     * The whole file used to be pasted here every single turn — and clamped to 3000
     * chars, so on a longer file the user's later rules were silently dropped and
     * never applied at all. Pointing at it costs a couple of lines per turn and the
     * agent reads the WHOLE thing when it matters.
     *
     * Deliberately worded stronger than the memory pointer below: this is the user's
     * standing ruleset, not agent notes, so it says it is authoritative and says WHEN
     * to read it. The heading list is what makes that reliable rather than hopeful —
     * a weak model can see whether the rules bear on the task instead of deciding
     * blind.
     */
    const content = [
      `## Project instructions — ${file} (${sizeKb} KB)`,
      `These are the user's standing rules for this project and they OVERRIDE your defaults.`,
      `Read them with read_file before you change code or make a design decision, and follow them.`,
      headings.length ? `Sections: ${headings.join(" · ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    logger.info(
      `Project instructions pointer (${instructions.source}, ${sizeKb}KB, ${headings.length} headings)`,
    );
    return { name: "projectMemory", priority: 4, content };
  } catch (memErr) {
    logger.warn("Failed to read project instructions:", memErr);
    return null;
  }
}

/**
 * Agent memory — the INDEX only.
 *
 * v13 auto-injected the whole of `.atlarix/memory.md` on every request, so the cost of
 * memory grew with how much the agent had learned (and was then truncated at 3000
 * chars, losing the tail). The store is now per-note under
 * `~/.atlarix/projects/<slug>/memory/`, and only its one-line-per-note index reaches
 * the prompt: cost scales with the NUMBER of notes, not their size.
 *
 * Framed as optional. A note is background that may save a re-scan — it is not an
 * instruction, and chasing one must never displace the user's actual task. Writing is
 * likewise recommended, never required, and `ATLARIX_MEMORY=off` removes this section
 * entirely so benchmark runs carry no memory surface at all.
 */
export async function loadMemoryMdSection(
  p: ContextSectionParams,
): Promise<ContextSection | null> {
  const { preflight, hasWorkspace, appPath } = p;
  if (!(hasWorkspace && appPath)) return null;
  try {
    const {
      isAgentMemoryDisabled,
      readMemoryIndex,
      migrateLegacyMemoryMd,
      memoryIndexPathFor,
    } = await import("@/lib/agent-memory");
    if (isAgentMemoryDisabled()) return null;

    const memory = await preflight.time("memory-index", async () => {
      // Carry a pre-v14.23.0 single file into the new store on first sight. Idempotent
      // and non-destructive (the original stays put), so it can run on every turn.
      const { readMemoryMd } = await import("@/lib/project-memory");
      const legacy = await readMemoryMd(appPath);
      if (legacy) await migrateLegacyMemoryMd(appPath, legacy);
      return readMemoryIndex(appPath);
    });
    if (!memory) return null;

    const indexPath = memoryIndexPathFor(appPath);
    const content = [
      `## Project memory — ${memory.noteCount} note(s), indexed at ${indexPath}`,
      memory.index || "(index empty — list the directory to see the notes)",
      `Optional: read a note with read_file when its line looks relevant to this task. When you learn something durable that the code does NOT already record, you may add a note (one fact per file, plus one index line) — never interrupt the user's task to do it. The full convention is the \`guides/memory\` entry under "Skills available"; read that file only when writing a note.`,
    ].join("\n");

    return { name: "projectKnowledge", priority: 3.9, content };
  } catch (memErr) {
    logger.warn("Failed to read agent memory index:", memErr);
    return null;
  }
}

// Marketplace skills are indexed by loadSkillsIndexSection above, alongside repo
// skills and the bundled guides — one section, one line per skill, bodies read
// on demand. Nothing here injects a skill body any more.
