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
  const { effectiveWorkMode, preflight } = p;
  try {
    const modeSkillName = getSkillNameForMode(effectiveWorkMode);
    // BUNDLED ONLY — no workspace argument, deliberately. A repo used to be able to
    // replace this text, which lands ahead of the base system prompt and cannot be
    // pruned; see `skill-loader.ts`.
    const modeSkillBody = await preflight.time("mode-skill", () =>
      loadSkill(modeSkillName),
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

/**
 * Where the workspace actually is, stated once per turn.
 *
 * THE BUG THIS FIXES
 * ------------------
 * Nothing ever told the model the absolute workspace path — not the system
 * prompt, not the mode bundles, not AGENTS.md. Yet `run_command` takes a `cwd`,
 * so the model had to produce a path it had never been given. Observed in the
 * packaged app: the workspace was `/Users/…/Github/railway-cli` and the agent
 * ran against `/Users/…/Github/AI/railway-cli` — it had spliced in the parent of
 * a DIFFERENT repo it had seen — then spent a turn hunting for the real root.
 *
 * Claude Code puts the working directory in its env block; we simply never did.
 * One line, built from the live `appPath`, so it follows the user's machine and
 * OS rather than assuming anything about either.
 *
 * Its own section rather than folded into workspace capabilities, because that
 * one returns null when a workspace has no skills or MCP servers — and the root
 * is not a capability, it is the ground the turn stands on.
 */
export function loadWorkspaceRootSection(
  p: ContextSectionParams,
): ContextSection | null {
  const { hasWorkspace, appPath } = p;
  if (!(hasWorkspace && appPath)) return null;
  return {
    name: "workspaceRoot",
    priority: -4,
    content: [
      `## Workspace`,
      "",
      `Absolute path: \`${appPath}\``,
      "",
      "`run_command` runs here by default — omit `cwd` unless you genuinely need a subdirectory, and pass an absolute path when you do. Never guess a path outside this root.",
    ].join("\n"),
  };
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
    const { getLatestPlanArtifact } = await import(
      "@/lib/plans/plan-artifacts"
    );
    const activePlan = await preflight.time(
      "plan-artifact",
      async () =>
        (await getLatestPlanArtifact(req.workspaceSessionId!, "building")) ??
        (await getLatestPlanArtifact(req.workspaceSessionId!)),
    );
    if (!activePlan?.content?.trim())
      return { section: null, taskLedgerBlock: null };
    // #A1: build the compact recency ledger block from the same fetch.
    let taskLedgerBlock: string | null;
    try {
      taskLedgerBlock = formatPlanChecklistForPrompt(
        parsePlanChecklist(activePlan.content),
        // The STORED title first. Scraping the markdown is the fallback for rows
        // written before the title column existed, and only for those: the
        // scrape takes the first non-empty line whatever it is, so a plan that
        // opens with a `## Goal` section heading used to reach the model named
        // "Goal". Storing the title fixed the UI; this line is what fixes it for
        // the agent, which is the half that actually matters on resume.
        activePlan.title ?? extractPlanChecklistTitle(activePlan.content),
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

    /**
     * EXHAUSTIVE, not a ternary chain with a default.
     *
     * This used to fall through to "CLAUDE.md" for anything it did not recognise, so
     * adding a source silently mislabelled it — the model would be told to read a file
     * that does not exist in the project. A `satisfies`-style exhaustive map makes a
     * new source a COMPILE error instead.
     *
     * `rules` names a directory rather than a file, and says how many are in it,
     * because "read them with read_file" is a single-file instruction that becomes
     * wrong for a set.
     */
    const file: string = ((): string => {
      switch (instructions.source) {
        case "rules": {
          const n = instructions.fileCount ?? 1;
          return `.atlarix/rules/ (${n} file${n === 1 ? "" : "s"})`;
        }
        case "atlarix":
          return ".atlarix/atlarix.md";
        case "agents":
          return "AGENTS.md";
        case "claude":
          return "CLAUDE.md";
      }
    })();
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
      instructions.source === "rules"
        ? `Read them with read_file — glob the directory, they all apply — before you change code or make a design decision, and follow them.`
        : `Read them with read_file before you change code or make a design decision, and follow them.`,
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
      adoptMisplacedMemoryDir,
      listMemoryNoteSizes,
      planMemoryCompaction,
    } = await import("@/lib/agent-memory");
    if (isAgentMemoryDisabled()) return null;

    const memory = await preflight.time("memory-index", async () => {
      // Carry a pre-v14.23.0 single file into the new store on first sight. Idempotent
      // and non-destructive (the original stays put), so it can run on every turn.
      const { readMemoryMd } = await import("@/lib/project-memory");
      const legacy = await readMemoryMd(appPath);
      if (legacy) await migrateLegacyMemoryMd(appPath, legacy);
      // Reclaim notes an earlier agent wrote to a guessed, human-readable path (see
      // the empty-state note below for how that happened). Also idempotent.
      await adoptMisplacedMemoryDir(appPath);
      return readMemoryIndex(appPath);
    });

    /**
     * No notes yet → no section at all.
     *
     * This used to emit a one-line section whose ONLY job was to name the memory
     * directory, because (in its own words) this was "the only place the absolute
     * memory path is published" — and returning null had previously caused agents
     * to invent a human-readable path and write notes outside the store.
     *
     * The path now ships in the runtime identity block at the top of every prompt
     * (`buildWorkstationIdentityBlock`), workspace or not, populated or not. So the
     * reason for this branch is gone, and keeping it would pay tokens on every turn
     * of every empty workspace to repeat something already stated above.
     */
    if (!memory) return null;

    // Memory compacts, it is never capped — so the signal has to reach the agent on a
    // turn where it happens to be writing a note AND on one where it isn't. The
    // edit_file notice covers the first; this covers the second.
    //
    // It rides the HEADER LINE that is already being paid for, as a few words. This
    // section renders on every turn, so a paragraph here is a paragraph on every request
    // until the store shrinks — the first version cost 147 tokens per turn, which is the
    // payload-instead-of-index mistake v14.25.0 existed to undo. The convention is
    // already one `guides/memory` pointer away; repeating it is not Atlarix's job.
    const compaction = await preflight.time("memory-compaction", async () =>
      planMemoryCompaction({ notes: await listMemoryNoteSizes(appPath) }),
    );

    // No absolute path here any more — the runtime identity block publishes it once,
    // at the top. This section carries only what CHANGES: the count, the compaction
    // flag and the index. That split is also what keeps the path in the cache-stable
    // header while the count stays out of it.
    const content = [
      `## Project memory — ${memory.noteCount} note(s)${compaction ? ` [${compaction.flag}]` : ""} (store location is in Runtime identity)`,
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
