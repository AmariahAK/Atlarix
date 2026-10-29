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
 * exactly like the agent-memory index (`MEMORY.md`). Nothing is capped
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
import { loadPlugins } from "@/lib/plugins/registry";
import { readSkills } from "@/lib/plugins/manifest";
import { userAgentSkillsParentDir } from "@/lib/plugins/paths";
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
  /**
   * `"installed"`: from a plugin the person installed, or `~/.agents/skills`.
   * Outside every project, so listed by line like the guides.
   */
  source: "repo" | "guide" | "installed";
}

/**
 * Bundled guides worth advertising.
 *
 * There used to be a `guides/memory` here. The memory rules now live in the
 * system header's "Project memory" section, where they are cached and always
 * present, so a model no longer has to find and read a guide before its first
 * note.
 */
const BUNDLED_GUIDES: Array<{
  file: string;
  name: string;
  description: string;
}> = [
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
 * Skills the person installed: each verified plugin's (registry.ts re-hashes them
 * on this load), then `~/.agents/skills`. A plugin skill is named `<plugin>:<skill>`.
 */
function installedSkillEntries(workspacePath: string | null): SkillIndexEntry[] {
  const out: SkillIndexEntry[] = [];
  for (const p of loadPlugins(workspacePath).plugins) {
    for (const s of p.contents.skills) {
      out.push({
        name: `${p.contents.name}:${s.name}`,
        description: s.description,
        readPath: s.skillPath,
        source: "installed",
      });
    }
  }
  for (const s of readSkills(userAgentSkillsParentDir())) {
    out.push({ name: s.name, description: s.description, readPath: s.skillPath, source: "installed" });
  }
  return out;
}

/**
 * Every skill available this turn, in read order: repo → installed → bundled.
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
    entries.push(...installedSkillEntries(ws ?? null));
  } catch (err) {
    logger.warn("[skill-index] installed skills failed:", err);
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
/**
 * WORKSPACE SKILLS ARE A COUNT, NOT A CATALOGUE.
 *
 * This used to emit a name, a description and a path for every skill, and briefly a
 * bounded version of the same. Both were the wrong shape: a workspace can hold any
 * number of skill files — they are the user's own markdown, and there is no refusing a
 * file that already exists — so the cost of describing them grew with the repo while
 * most of them were irrelevant to any given task.
 *
 * The model does not need the catalogue to use a skill. It needs to KNOW skills exist,
 * and it already has `grep` and `glob` to read the directory when a task looks like
 * something the project has a written procedure for. One line buys the first; the tools
 * it already has cover the second. (A `find_skill` tool was written for this and deleted
 * the same day — it was a second way to do a thing that works.)
 *
 * The old caps failed differently and worse, so it is worth being precise about the
 * difference: they dropped skills SILENTLY, telling the model that skills 11+ did not
 * exist. Nothing is hidden here — the count is of everything, and the directory is
 * named.
 */

export function formatSkillIndexForPrompt(entries: SkillIndexEntry[]): string {
  if (!entries.length) return "";

  const project = entries.filter((e) => e.source === "repo");
  const guides = entries.filter((e) => e.source === "guide");
  const installed = entries.filter((e) => e.source === "installed");
  const render = (e: SkillIndexEntry) =>
    e.description
      ? `- **${e.name}** — ${e.description}\n  \`${e.readPath}\``
      : `- **${e.name}**\n  \`${e.readPath}\``;

  const lines: string[] = [];
  if (project.length) {
    lines.push(
      `## Skills (${project.length})`,
      `This project has ${project.length} skill file(s) in \`.atlarix/skills/\` — written procedures for jobs it does repeatedly. When a task looks like one of them, \`grep\` or \`glob\` that directory and \`read_file\` the one that fits BEFORE doing the work it covers. Optional: never chase a skill at the cost of the user's actual task.`,
    );
  }

  // Installed skills keep their lines for the guides' reason: they live outside
  // the project, where grep cannot reach them. The person chose each one.
  if (installed.length) {
    if (lines.length) lines.push("");
    lines.push(`## Installed skills (${installed.length})`);
    lines.push(
      "Skills the user installed. `read_file` one when its line fits the task, before doing the work it covers. Their folders are not the project: never `cd` into them or write there.",
    );
    for (const e of installed) lines.push(render(e));
  }

  // Bundled guides are split out and labelled because their path points INSIDE
  // the installed application, not into any project. Listed flat among the
  // workspace's own skills, a model read that absolute path as somewhere it
  // could work and prefixed a shell command with `cd <app>/Contents/Resources`
  // — after which every relative filename in the user's repo stopped resolving.
  // The path has to stay (read_file needs it), so the fix is to say plainly what
  // the directory is and that it is not a place to go.
  if (guides.length) {
    // Guides KEEP their lines, unlike workspace skills above. They live inside the
    // application bundle, so grep over the project cannot reach them — a count would
    // make them unreachable rather than merely unlisted. They are also few and fixed,
    // so the cost does not grow.
    if (lines.length) lines.push("");
    lines.push(`## Built-in guides (${guides.length})`);
    lines.push(
      "Reference documents shipped inside the Atlarix application — read-only, and NOT part of this or any project. `read_file` one when its line applies. Never `cd` into these paths, never write to them, and never treat them as the workspace: your working directory is the project folder, always.",
    );
    for (const e of guides) lines.push(render(e));
  }

  return lines.join("\n");
}
