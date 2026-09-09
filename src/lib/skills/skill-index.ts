/**
 * The skills INDEX (v14.25.0).
 *
 * Skills used to be pasted into the prompt whole, every turn: marketplace
 * SKILL.md bodies capped at 10 skills / 6 KB each / 24 KB total (≈6k tokens),
 * plus every matching `.atlarix/skills/*.md` body with no cap at all. That cost
 * the same tokens whether or not the turn had anything to do with any of them,
 * and — worse — it CLIPPED: `cap()` cut a body mid-file, the 11th skill vanished
 * without a trace, and the names summary stopped at 10. A truncated instruction
 * is worse than an absent one, because the model cannot tell it is reading a
 * fragment.
 *
 * So this emits one line per skill — name, description, and the path to read —
 * exactly like the agent-memory index (`loadMemoryMdSection`). Nothing is capped
 * and nothing is clipped: the index lists EVERY skill, and the model reads the
 * whole body with `read_file` when a line looks relevant to the task. Cost now
 * scales with the NUMBER of skills, not their size.
 *
 * Every path here is directly readable by `read_file`: marketplace and repo
 * skills live inside the workspace (relative paths), and bundled guides get
 * their resolved absolute path — which `read_file` accepts unconditionally
 * (file.ts: absolute reads are allowed anywhere; the approval gate governs
 * WRITES).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import log from "electron-log";

import { firstSentence } from "@/lib/text/first-sentence";
import { resolveBuiltinSkillsRoot } from "./skill-loader";
import {
  filterSkillsForMode,
  loadPrioritySkillsForWorkspace,
} from "./priority-skill-loader";

const logger = log.scope("skill-index");

export interface SkillIndexEntry {
  name: string;
  description: string;
  /** What the model passes to `read_file` — workspace-relative, or absolute for bundled guides. */
  readPath: string;
  /**
   * `"installed"` is gone with the marketplace (v14.45). It rendered identically to
   * `"repo"` in `formatSkillIndexForPrompt`, so nothing downstream distinguished them.
   */
  source: "repo" | "guide";
}

/**
 * Bundled guides worth advertising.
 *
 * `guides/memory` was already REFERENCED by the memory context section ("the
 * full convention is in the `guides/memory` skill") while nothing in the app
 * could resolve that name — no tool took it, and the file ships outside the
 * workspace. The index is what finally makes that sentence actionable.
 */
const BUNDLED_GUIDES: Array<{
  file: string;
  name: string;
  description: string;
}> = [
  {
    file: "guides/memory.md",
    name: "guides/memory",
    description:
      "How to write a project-memory note (one fact per file, plus an index line). Read before writing one.",
  },
  {
    file: "guides/data-visualization.md",
    name: "guides/data-visualization",
    description:
      "Fence schemas for inline charts, graphs and markmaps rendered in chat.",
  },
];

/** Bundled guides that actually exist in this build. */
async function loadGuideEntries(): Promise<SkillIndexEntry[]> {
  const root = resolveBuiltinSkillsRoot();
  const out: SkillIndexEntry[] = [];
  for (const guide of BUNDLED_GUIDES) {
    const abs = path.join(root, ...guide.file.split("/"));
    try {
      await fs.access(abs);
      out.push({
        name: guide.name,
        description: guide.description,
        // The NAME, not the absolute path. `read_file` resolves it — see
        // `bundled-guide-path.ts` for why the install location must not reach
        // the model. (It is still `access`ed above so a guide missing from this
        // build is not advertised.)
        readPath: guide.name,
        source: "guide",
      });
    } catch {
      // Not in this build's resources — don't advertise a path that 404s.
    }
  }
  return out;
}

/**
 * Every skill available this turn, in read order: repo → marketplace → bundled.
 *
 * `currentMode` filters repo skills by their `modes`/`compatibleModes`
 * frontmatter, so a Build-only skill doesn't advertise itself in Explore.
 */
export async function buildSkillIndex(
  workspacePath: string | null | undefined,
  currentMode: string,
): Promise<SkillIndexEntry[]> {
  const ws = workspacePath?.trim();
  const entries: SkillIndexEntry[] = [];

  if (ws) {
    try {
      const repo = filterSkillsForMode(
        await loadPrioritySkillsForWorkspace(ws, false),
        currentMode,
      );
      for (const s of repo) {
        entries.push({
          name: s.name,
          description: firstSentence(s.description || s.content),
          readPath: `.atlarix/skills/${s.filename}`,
          source: "repo",
        });
      }
    } catch (err) {
      logger.warn("[skill-index] repo skills failed:", err);
    }
  }

  try {
    entries.push(...(await loadGuideEntries()));
  } catch (err) {
    logger.warn("[skill-index] bundled guides failed:", err);
  }

  return entries;
}

/**
 * Render the index for the prompt.
 *
 * Framed like the memory pointer: optional, read when a line looks relevant,
 * never at the cost of the task. No caps, no truncation — every entry gets a
 * line, however many there are.
 */
export function formatSkillIndexForPrompt(entries: SkillIndexEntry[]): string {
  if (!entries.length) return "";
  const render = (e: SkillIndexEntry) =>
    e.description
      ? `- **${e.name}** — ${e.description}\n  \`${e.readPath}\``
      : `- **${e.name}**\n  \`${e.readPath}\``;

  const project = entries.filter((e) => e.source !== "guide");
  const guides = entries.filter((e) => e.source === "guide");

  const lines: string[] = [];
  if (project.length) {
    lines.push(`## Skills available (${project.length})`);
    lines.push(
      "Each line is a skill you can read in full. When one looks relevant to the task, `read_file` its path BEFORE doing the work it covers — the line is a summary, the file is the instruction. Optional: never chase a skill at the cost of the user's actual task.",
    );
    for (const e of project) lines.push(render(e));
  }

  // Bundled guides are split out and labelled because their path points INSIDE
  // the installed application, not into any project. Listed flat among the
  // workspace's own skills, a model read that absolute path as somewhere it
  // could work and prefixed a shell command with `cd <app>/Contents/Resources`
  // — after which every relative filename in the user's repo stopped resolving.
  // The path has to stay (read_file needs it), so the fix is to say plainly what
  // the directory is and that it is not a place to go.
  if (guides.length) {
    if (lines.length) lines.push("");
    lines.push(`## Built-in guides (${guides.length})`);
    lines.push(
      "Reference documents shipped inside the Atlarix application — read-only, and NOT part of this or any project. `read_file` one when its line applies. Never `cd` into these paths, never write to them, and never treat them as the workspace: your working directory is the project folder, always.",
    );
    for (const e of guides) lines.push(render(e));
  }

  return lines.join("\n");
}
