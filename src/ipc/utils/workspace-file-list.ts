/**
 * The one file-listing engine.
 * =============================
 * Every file lookup in the product — `@`-mention autocomplete, the scoped
 * `@dir:` listing, and the "did you mean this path?" hint after a failed
 * read/edit — comes through here, on the BUNDLED ripgrep that `grep` and `glob`
 * already use (`resolveRipgrepPath`).
 *
 * WHAT THIS REPLACED
 * ------------------
 * `project-files.ts` cascaded `fd` → a system `rg` probed on PATH → a legacy
 * synchronous walk, and the two strategies that do NOT honour `.gitignore`
 * needed a hand-maintained exclusion list to compensate (26 directory names
 * plus a 64-hex-segment rule for CDK asset dirs — a list shaped by whichever
 * project its author had open). Two consequences, both real:
 *
 * - `@`-mention behaved DIFFERENTLY PER USER. With `fd` installed you got the
 *   `--no-ignore-vcs` path, which offers gitignored files; without it you got
 *   ripgrep, which doesn't. Same app, same repo, different list.
 * - The `fd` path overflowed the 4,000-path cap on this repo (5,505 files), so
 *   ~1,500 files simply could not be `@`-mentioned.
 *
 * `.gitignore` already excludes build output, so the whole list was redundant.
 * The single exclusion that survives is `.git/**`, and only because `--hidden`
 * makes ripgrep list it — derived from an observed need, not an ecosystem list.
 *
 * WHY ENUMERATE-THEN-FILTER-IN-NODE
 * ---------------------------------
 * The obvious move is to push the user's query into ripgrep as `--iglob "*q*"`
 * and let it do the filtering. That is NOT equivalent to what the composer does
 * today, and the difference is large: a ripgrep glob with no `/` in it matches
 * the BASENAME only, while the composer matches a substring of the whole
 * relative path. Measured on this repo, query `chat`:
 *
 *     --iglob '*chat*'                     →  60 files
 *     path.includes("chat")  (today)       → 209 files
 *
 * `src/components/chat/Composer.tsx` is in the second set and not the first, so
 * the glob version would silently stop finding everything under a matching
 * DIRECTORY. Enumeration costs 15-20 ms here, so there is nothing to win by
 * pushing the filter down. ripgrep enumerates; Node filters.
 *
 * WHY THERE IS NO CACHE
 * ---------------------
 * The old 5-minute TTL is exactly what made `suggestClosestPath` answer a
 * post-rename miss with the PRE-rename path — the one moment that helper exists
 * for. At 15-20 ms a run, staleness costs more than the spawn. React Query
 * already coalesces the composer's calls.
 *
 * SCOPING IS DONE HERE, NOT BY MOVING `cwd`
 * -----------------------------------------
 * A scoped listing (`@dir:packages/api`) enumerates from the WORKSPACE ROOT and
 * prefix-filters, rather than pointing ripgrep at the subdirectory. `.gitignore`
 * patterns are resolved relative to the ignore file's own directory, so passing
 * the workspace's `.gitignore` via `--ignore-file` while `cwd` sits in a
 * subdirectory mis-applies every relative pattern in it. One root, one ignore
 * context, correct answers.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import log from "electron-log";
import { resolveRipgrepPath } from "@/lib/tools/resolve-ripgrep";
import { ripgrepIgnoreArgs } from "@/lib/tools/ripgrep-ignore";

const execFileAsync = promisify(execFile);
const logger = log.scope("workspace-file-list");

/**
 * ripgrep lists `.git/**` under `--hidden` (19 files here). It is the only
 * exclusion left, and unlike the list it replaced it is derived from an
 * observed need rather than a guess about what a project might contain.
 */
const GIT_DIR_EXCLUDE = "!.git/**";

/**
 * `--hidden` is NOT part of `ripgrepIgnoreArgs`, and it has to be added here.
 *
 * `glob` deliberately omits it (a bare `glob '*'` should not open with dotfiles).
 * `@`-mention is the opposite case: the old discovery path passed `--hidden` on
 * both live strategies, so `.github/workflows/ci.yml` and `.env.example` are
 * mentionable TODAY. Dropping it would read as "@ stopped finding my workflow
 * files" with no visible cause.
 */
async function listArgs(workspacePath: string): Promise<string[]> {
  return [
    "--files",
    "--hidden",
    ...(await ripgrepIgnoreArgs(workspacePath)),
    "--glob",
    GIT_DIR_EXCLUDE,
  ];
}

/**
 * Every workspace-relative file path, honouring `.gitignore` / `.atlarixignore`.
 *
 * Returns `[]` rather than throwing when the workspace has no files or does not
 * exist — every caller here is an assistive feature (autocomplete, a hint after
 * a failure) where an empty list degrades gracefully and an exception would take
 * a real interaction down with it.
 */
export async function listWorkspaceFiles(
  workspacePath: string,
): Promise<string[]> {
  if (!workspacePath) return [];
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      await resolveRipgrepPath(),
      await listArgs(workspacePath),
      { cwd: workspacePath, maxBuffer: 50 * 1024 * 1024 },
    ));
  } catch (e) {
    // `rg --files` exits 1 when nothing matched — not an error. Exit 2 is a real
    // failure (unreadable cwd, malformed ignore file); both degrade to an empty
    // list here, but only the latter is worth a log line.
    const err = e as { code?: number; stderr?: string };
    if (err.code !== 1) {
      logger.warn(
        `ripgrep failed to list ${workspacePath}: ${(err.stderr || "").trim().split("\n")[0] || "unknown error"}`,
      );
    }
    return [];
  }
  return (
    stdout
      .split("\n")
      .map((line) => line.trim().replace(/\\/g, "/"))
      .filter(Boolean)
      // ripgrep walks in parallel and does NOT emit a stable order — two runs on
      // an unchanged tree come back differently shuffled. That never showed
      // before because the old path built the list once and cached it for five
      // minutes; now that every keystroke is its own run, an unsorted list would
      // reshuffle the `@` menu under the user's cursor mid-type.
      .sort(compareForMention)
  );
}

/**
 * Deterministic AND useful ordering.
 *
 * A plain `.sort()` is deterministic, which is what the menu needs, but it is
 * lexicographic — so every dotfile sorts first and `@` opened on `.cargo/`,
 * `.github/`, `.github/workflows/`, `.cargo/audit.toml`… with the actual
 * contents of the repo pushed below the fold. Correct, and useless.
 *
 * Order: visible before hidden, then shallower before deeper, then
 * lexicographic. Hidden files stay fully reachable — typing `.gith` still finds
 * them — they just stop being what you see first. Depth before name because
 * `src/main.ts` is a likelier mention than `src/a/b/c/helper.ts`.
 */
function isHiddenPath(p: string): boolean {
  return p.split("/").some((seg) => seg.startsWith("."));
}

export function compareForMention(a: string, b: string): number {
  const hiddenA = isHiddenPath(a);
  const hiddenB = isHiddenPath(b);
  if (hiddenA !== hiddenB) return hiddenA ? 1 : -1;

  const depthA = a.split("/").length;
  const depthB = b.split("/").length;
  if (depthA !== depthB) return depthA - depthB;

  return a.localeCompare(b);
}

/**
 * Files whose relative path contains `query`, case-insensitively.
 *
 * Substring over the WHOLE relative path — byte-identical to the filter the
 * composer has always applied client-side (`.toLowerCase().includes(q)`), which
 * is why typing `@chat` still surfaces `src/components/chat/Composer.tsx`. An
 * empty query returns everything.
 *
 * `limit` caps what is DISPLAYED, not what is searched — the difference from the
 * old `MENTION_PATHS_LIMIT`, which capped the corpus and therefore hid files
 * from search entirely.
 */
export async function searchWorkspaceFiles(
  workspacePath: string,
  query: string,
  limit?: number,
): Promise<string[]> {
  const all = await listWorkspaceFiles(workspacePath);
  const q = query.trim().toLowerCase();
  const matched = q ? all.filter((f) => f.toLowerCase().includes(q)) : all;
  return limit != null ? matched.slice(0, limit) : matched;
}

/**
 * Files under `relDir`, returned relative to that directory.
 *
 * Backs the `@dir:` mention, whose caller re-roots them under the mentioned
 * folder. Enumerates from the workspace root and prefix-filters — see the file
 * header for why this does not point ripgrep at the subdirectory.
 */
export async function listWorkspaceFilesUnder(
  workspacePath: string,
  relDir: string,
): Promise<string[]> {
  const all = await listWorkspaceFiles(workspacePath);
  const dir = relDir.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/+$/, "");
  if (!dir) return all;
  const prefix = `${dir}/`;
  return all
    .filter((f) => f.startsWith(prefix))
    .map((f) => f.slice(prefix.length));
}
