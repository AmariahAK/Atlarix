/**
 * Bundled guides are read by NAME. The model never sees where Atlarix is
 * installed.
 *
 * WHAT THIS REPLACED, AND WHY IT WAS WRONG
 * ----------------------------------------
 * The skills index used to advertise each bundled guide by its resolved
 * absolute path, which in a packaged app is inside the bundle:
 *
 *   /Users/<you>/…/Atlarix.app/Contents/Resources/skills/guides/memory.md
 *
 * It worked, and it was still wrong three ways:
 *
 * 1. INSTALL-SPECIFIC. A dev build says `…/out/Atlarix-darwin-arm64/…`; an
 *    installed one says `/Applications/…`. The model was being handed a fact
 *    about the user's filesystem that has nothing to do with their project.
 * 2. EXPENSIVE. ~120 characters per guide, in the index, every turn.
 * 3. IT TAUGHT THE MODEL TO INVENT PATHS. Observed: told to "read
 *    `guides/memory`" without a usable path in reach, the model produced
 *    `/Users/armaan/.atlarix/guides/memory.md` — right shape, invented home
 *    directory (the user is `amariah`), wrong subpath. Three tool errors before
 *    it gave up. A model handed unreconstructable paths learns to reconstruct
 *    them anyway.
 *
 * No comparable harness does this: Claude Code, opencode and Codex load their
 * own bundled resources by name. Where the app lives is not the model's
 * business.
 *
 * So the index emits `guides/<name>`, and this resolves it at read time.
 */

import * as path from "node:path";
import { resolveBuiltinSkillsRoot } from "./skill-loader";

/** The prefix that marks a bundled-guide reference rather than a real path. */
const GUIDE_PREFIX = "guides/";

/**
 * True when `p` names a bundled guide rather than a file in the workspace.
 *
 * Deliberately narrow: an actual `guides/` directory in someone's repo is
 * ordinary and must keep resolving normally, so the caller tries the workspace
 * FIRST and only falls back to here.
 */
export function looksLikeBundledGuide(p: string): boolean {
  const norm = p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  return norm.startsWith(GUIDE_PREFIX) && !norm.includes("..");
}

/**
 * Absolute path of a bundled guide, or null when the name doesn't match one.
 *
 * `.md` is optional so both `guides/<name>` (what the index advertises) and
 * `guides/<name>.md` (what a model may write out of habit) resolve — absorbing
 * the alias rather than prompting against it, per the v14.22.0 rule.
 */
export function resolveBundledGuidePath(p: string): string | null {
  if (!looksLikeBundledGuide(p)) return null;
  const norm = p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  const withExt = norm.endsWith(".md") ? norm : `${norm}.md`;
  const root = resolveBuiltinSkillsRoot();
  const abs = path.join(root, ...withExt.split("/"));
  // Containment: `looksLikeBundledGuide` already rejects `..`, and this catches
  // anything that still escapes the guides root after joining.
  const guidesRoot = path.join(root, "guides");
  const rel = path.relative(guidesRoot, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return abs;
}
