/**
 * Load a BUNDLED mode or sub-agent skill (main process).
 *
 * A WORKSPACE OVERRIDE USED TO WIN HERE, AND IT WAS A PROMPT-INJECTION HOLE.
 *
 * This function used to read `<workspace>/.atlarix/skills/<name>.md` first and return it
 * instead of the bundled file. Since the only names ever passed are `modes/<mode>` and
 * `subagents/subagent{,-writer}`, that meant a repo could ship
 * `.atlarix/skills/modes/build-mode.md` and REPLACE Atlarix's own operating instructions
 * verbatim, from the first turn — or `subagents/subagent-writer.md` and replace a
 * write-capable sub-agent's ENTIRE system prompt.
 *
 * `.atlarix/` is committed by design, and a repo arriving mid-session is the normal case,
 * so "someone else's file" is the expected input. What made it sharp rather than
 * theoretical: mode-skill text is prepended AHEAD of the base system prompt
 * (`prompt-bundle.ts`), carries no untrusted-data envelope and no control-tag escaping,
 * is in `PROTECTED_NAMES` so context pressure cannot prune it, gets an 8,000-token
 * ceiling against real mode skills of ~600, and never appears in any skills UI because
 * the index loader skips subdirectories. It outranked `.atlarix/atlarix.md`, which the
 * auto-approve carve-out already protects for exactly this reason.
 *
 * Nothing pinned it: no test exercised the override, and the only comment describing it
 * cited a `docs/atlarix-contract.md` that does not exist and named the wrong directory.
 * It predates the "skills are an index, not a payload" rework and was never revisited.
 *
 * So there is no `workspacePath` parameter any more — not a filtered one, none. A
 * per-project instruction layer belongs in `.atlarix/rules/`, which is injected as a
 * POINTER the model chooses to read, and per-project agents in `.atlarix/agents/`, which
 * the user selects. Neither can silently become the operating instructions.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { app } from "electron";
import { applySharedPromptFragments } from "@/lib/prompts/shared-fragments";
import { bundledSkillsDir } from "@/runtime/embedded-skills";

const skillCache = new Map<string, string>();

export function resolveBuiltinSkillsRoot(): string {
  // The CLI and headless builds carry their own copy (src/headless/bundled-assets.ts):
  // their `cwd` is the user's repository, where `src/skills` is not Atlarix's.
  const bundled = bundledSkillsDir();
  if (bundled) return bundled;
  try {
    if (app.isPackaged) {
      // packagerConfig.extraResource copies `src/skills` → resources/skills (basename)
      return path.join(process.resourcesPath, "skills");
    }
    return path.join(app.getAppPath(), "src", "skills");
  } catch {
    return path.join(process.cwd(), "src", "skills");
  }
}

export function clearSkillCache(): void {
  skillCache.clear();
}

/**
 * @param skillName e.g. `modes/ask-mode` or `subagents/subagent` (no `.md`)
 */
export async function loadSkill(skillName: string): Promise<string> {
  const safeName = skillName.replace(/^\/+|\.md$/g, "").replace(/\.\./g, "");
  if (!safeName) return "";

  const cached = skillCache.get(safeName);
  if (cached !== undefined) return cached;

  const builtInRoot = resolveBuiltinSkillsRoot();
  const builtInPath = path.join(builtInRoot, ...safeName.split("/")) + ".md";

  /**
   * Containment, not just a `..` strip.
   *
   * `safeName` deletes literal `..` sequences, which is a blocklist — and a blocklist is
   * what the removed override relied on. `skillName` is a literal at both call sites
   * today, so this is belt-and-braces, but it is the check `bundled-guide-path.ts`
   * already uses for the same directory and it costs nothing to be consistent.
   */
  const resolved = path.resolve(builtInPath);
  if (
    resolved !== path.resolve(builtInRoot) &&
    !resolved.startsWith(path.resolve(builtInRoot) + path.sep)
  ) {
    return "";
  }
  // Shared fragments ({{REUSE_FIRST_LADDER}}) resolve here, so the writer
  // sub-agent's reuse-first discipline is the SAME text the main agent gets
  // rather than a second copy that can drift.
  const content = applySharedPromptFragments(
    await fs.readFile(builtInPath, "utf8"),
  );
  skillCache.set(safeName, content);
  return content;
}
