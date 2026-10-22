/**
 * `grep` — text/regex content search via ripgrep (v13; extracted from the
 * deleted unified `search` tool's text mode — the renderer match-list card
 * keys off the same `ui.groups` payload shape).
 *
 * Pure ripgrep: matches are returned in ripgrep's own order (the same shape
 * Claude Code / opencode / codex ship). There is no symbol index or relevance
 * rerank — a smart model narrows its own query when a result set is too broad.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import * as path from "node:path";
import { truncateUtf8ByBytes } from "@/lib/truncate";
import { ripgrepIgnoreArgs } from "./ripgrep-ignore";
import { classifyRgFailure, expandHome, unreadableNote } from "./search-root";
import { resolveRipgrepPath } from "./resolve-ripgrep";
import { resolveToolTargetPath } from "@/ipc/utils/safeWorkspaceRelativePath";
import {
  ToolRegistry,
  createParameters,
  stringParam,
  booleanParam,
  numberParam,
} from "./registry";

const execFileAsync = promisify(execFile);

type GrepGroup = {
  file: string;
  matches: { line: number; content: string }[];
  /** Workspace-relative path (set for display). */
  relFile?: string;
  /**
   * The pattern matched, but the file holds a NUL byte so ripgrep will not print
   * the lines. Reported rather than dropped — see `--binary` in `buildArgs`.
   */
  binary?: boolean;
};

/**
 * ripgrep's binary-file notice: `<path>: binary file matches (found "\0" byte …)`.
 * A path, a COLON-SPACE, and no line number — which is why the match regex below
 * (which requires `:<digits>:`) can never claim it.
 */
const BINARY_MATCH_RE = /^((?:[A-Za-z]:)?[^:]*): binary file matches\b/;

/** Exported for tests: Windows output shapes are unreachable from a POSIX runner. */
export function parseGrepOutput(output: string): GrepGroup[] {
  const groups: GrepGroup[] = [];
  const lines = output.split("\n");
  let current: GrepGroup | null = null;

  for (const line of lines) {
    if (!line.includes(":")) continue;

    // A file whose matches cannot be shown is still a file that MATCHED. Left
    // unparsed this line was dropped by the `if (!m) continue` below for having
    // no `:<line>:`, so grep answered "No matches" for a file it had just been
    // told about — the same silent wrong answer the drive-letter comment guards
    // against. Four files in this repo were invisible to grep this way.
    const bin = BINARY_MATCH_RE.exec(line);
    if (bin?.[1]) {
      if (current) {
        groups.push(current);
        current = null;
      }
      groups.push({ file: bin[1], matches: [], binary: true });
      continue;
    }

    // A Windows drive letter carries its own colon, so a plain `split(":")` tore
    // `C:\repo\pkg\loader.go:3:text` into file="C", lineNum="\repo\pkg\loader.go"
    // — `parseInt` returned NaN and the match was DISCARDED. Since ripgrep is
    // handed an absolute search root, every path it prints on Windows starts with
    // a drive letter, so every match was dropped and grep reported "No matches"
    // however many there were. A silent wrong answer, which is the worst kind:
    // the model concludes the code it is looking for does not exist.
    //
    // The optional `[A-Za-z]:` prefix absorbs the drive; `[^:]*` then holds the
    // rest of the path, which cannot contain a colon on either platform.
    const m = /^((?:[A-Za-z]:)?[^:]*):(\d+):([\s\S]*)$/.exec(line);
    if (!m) continue;
    const file = m[1];
    const num = parseInt(m[2], 10);
    const content = [m[3]];
    if (!file || isNaN(num)) continue;

    if (current && current.file !== file) {
      groups.push(current);
      current = null;
    }
    if (!current) current = { file, matches: [] };
    current.matches.push({ line: num, content: content.join(":").trim() });
  }
  if (current) groups.push(current);
  return groups;
}

async function runRipgrepSearch(args: {
  pattern: string;
  /** Where the search starts: the workspace, or a folder outside it. */
  root: string;
  workspace: string;
  contextLines: number;
  filePattern?: string;
  caseSensitive: boolean;
}): Promise<{ groups: GrepGroup[]; unreadable: string[] }> {
  const { pattern, root, workspace, contextLines, filePattern, caseSensitive } = args;
  // `--no-require-git` + optional .atlarixignore, so ignores are honored even in
  // a non-git workspace (matches the glob tool; see ripgrep-ignore.ts). A root
  // outside the workspace gets none of the workspace's ignores.
  const ignoreArgs = await ripgrepIgnoreArgs(workspace, root);
  // Argv form (no shell): pattern/filePattern are model-controlled, so they must
  // never be interpolated into a shell string — `rg` receives them as literal
  // argv entries. `--` terminates option parsing so a pattern beginning with `-`
  // is treated as a pattern, not a flag.
  const buildArgs = (extra: string[]) => [
    "-n",
    // Without this, a RECURSIVE search skips any file containing a NUL byte and
    // says nothing at all — the notice below is only printed for files named
    // explicitly on the command line, which is not how this tool searches. So a
    // source file with one stray NUL (a separator written as a literal instead
    // of the escape `\u0000` — there were four in this repo) was unsearchable,
    // and grep reported it as having no matches. `--binary` reports instead of
    // skipping; it does NOT dump binary content, just one `binary file matches`
    // line per file.
    "--binary",
    "-C",
    String(contextLines),
    ...(caseSensitive ? [] : ["-i"]),
    ...(filePattern ? ["-g", filePattern] : []),
    ...ignoreArgs,
    ...extra,
    "--",
    pattern,
    root,
  ];

  const rgPath = await resolveRipgrepPath();
  const runOnce = async (extra: string[]) => {
    const { stdout } = await execFileAsync(rgPath, buildArgs(extra), {
      maxBuffer: 10 * 1024 * 1024,
    });
    return { groups: parseGrepOutput(stdout), unreadable: [] };
  };

  // Exit 2 is ALSO what one unreadable folder gives, with the matches still on
  // stdout (QA A1, 2026-10-22): keep those and say which folders were skipped.
  const walkOnly = (e: unknown) => {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    if (err.code !== 2) return null;
    const failure = classifyRgFailure(err);
    return failure.kind === "walk"
      ? { groups: parseGrepOutput(failure.stdout), unreadable: failure.unreadable }
      : null;
  };

  try {
    return await runOnce([]);
  } catch (e) {
    // ripgrep exit codes: 0 = matches, 1 = NO matches (not an error), 2 = a real
    // error (most commonly a regex the default Rust engine can't parse, e.g.
    // lookahead/backreferences). Previously ALL of these collapsed to "no
    // matches", so an unsupported pattern silently returned empty and the model
    // wrongly concluded there was nothing to find. Distinguish them:
    const err = e as { code?: number; stderr?: string };
    if (err.code === 1) return { groups: [], unreadable: [] }; // genuinely no matches
    const walked = walkOnly(e);
    if (walked) return walked;
    // Retry once with PCRE2 so lookahead/backreferences/etc. actually work.
    try {
      return await runOnce(["--pcre2"]);
    } catch (e2) {
      const err2 = e2 as { code?: number; stderr?: string };
      if (err2.code === 1) return { groups: [], unreadable: [] };
      const walked2 = walkOnly(e2);
      if (walked2) return walked2;
      const msg = (err2.stderr || err.stderr || "").trim().split("\n")[0];
      // Surface the real problem to the model instead of a misleading "no
      // matches" so it can fix the pattern rather than trust an empty result.
      throw new Error(
        msg ? `Invalid grep pattern: ${msg}` : "grep failed to run the pattern",
      );
    }
  }
}

function pathToRipgrepGlob(scopePath: string | undefined): string | undefined {
  if (!scopePath) return undefined;
  const p = scopePath.replace(/^\//, "").replace(/\\/g, "/");
  if (p.includes("*")) return p;
  if (/\.[a-zA-Z0-9]{1,8}$/.test(p)) return `**/${p}`;
  return `**/${p}/**`;
}

function formatGrepGroupsForDisplay(
  groups: GrepGroup[],
  query: string,
  opts?: { perFileCap?: number; maxBytes?: number },
): string {
  const perFile = Math.min(100, Math.max(1, opts?.perFileCap ?? 5));
  const maxBytes = Math.min(500_000, Math.max(1024, opts?.maxBytes ?? 24_000));
  if (groups.length === 0) return `No matches for "${query}".`;
  const total = groups.reduce((s, g) => s + g.matches.length, 0);
  // Binary files are counted separately: they matched, but contributed no lines,
  // so folding them into `total` would claim matches that are not shown below.
  const binaryCount = groups.filter((g) => g.binary).length;
  const shownFiles = groups.length - binaryCount;
  let out = `${total} match(es) for "${query}" across ${shownFiles} file(s)`;
  out += binaryCount
    ? `, plus ${binaryCount} binary file(s) that matched:\n\n`
    : `:\n\n`;
  for (const g of groups) {
    out += `${g.relFile ?? g.file}\n`;
    if (g.binary) {
      // Says what happened AND what to do about it — a dead end the model cannot
      // act on is barely better than the silent skip this replaced.
      out +=
        `  matched, but this file contains a NUL byte so ripgrep will not print` +
        ` its lines. Read the file directly to see the match.\n\n`;
      continue;
    }
    for (const m of g.matches.slice(0, perFile)) {
      out += `  ${m.line}: ${m.content}\n`;
    }
    if (g.matches.length > perFile)
      out += `  … +${g.matches.length - perFile} more in this file\n`;
    out += "\n";
  }
  return truncateUtf8ByBytes(out, maxBytes, {
    suffix:
      "\n\n… [output truncated; narrow path/include or lower max_results]",
  });
}

ToolRegistry.register({
  name: "grep",
  description:
    "Search file CONTENTS with a regex (ripgrep). Returns matching lines grouped by file, " +
    "respecting .gitignore. Use glob to find files by NAME. Raise max_results for a wider sweep; " +
    "narrow with path/include to focus. " +
    'Examples: grep({ pattern: "handleLogin" }), grep({ pattern: "TODO|FIXME", include: "*.ts" }).',
  requiresWorkspace: true,
  isCore: true,
  isReadOnly: true,
  allowInAskMode: true,
  parameters: createParameters(
    {
      pattern: stringParam("Regex (ripgrep syntax) or literal text to find."),
      path: stringParam(
        "Optional: limit to a folder or file. Workspace-relative by default; to search outside the workspace, give its ABSOLUTE path.",
      ),
      include: stringParam(
        "Optional file glob filter (e.g. '*.ts', 'src/**/*.tsx').",
      ),
      case_sensitive: booleanParam("Case-sensitive match (default false)."),
      context_lines: numberParam(
        "Lines of context around each match (default 0, max 10).",
        0,
        0,
        10,
      ),
      max_results: numberParam(
        "Max matching lines (default 20, max 200).",
        20,
        1,
        200,
      ),
      max_bytes: numberParam(
        "Max UTF-8 bytes of formatted output (default 24000).",
        24_000,
        4096,
        500_000,
      ),
      // `workspace` / `workspaceId` are NOT advertised. The turn runner injects
      // them by spreading `...tc.args` and then overwriting, so anything the
      // model sent was discarded — it was paying tokens for parameters it could
      // not affect, and being invited to guess a workspace id. Same treatment
      // `chatMode` and `_chatSessionId` already got. The handler below still
      // receives them; they simply never enter the model's schema.
    },
    ["pattern"],
  ),
  handler: async (params: {
    pattern: string;
    path?: string;
    include?: string;
    case_sensitive?: boolean;
    context_lines?: number;
    max_results?: number;
    max_bytes?: number;
    /** Injected by the turn runner, never advertised — see above. */
    workspace?: string;
    /** Injected by the turn runner, never advertised — see above. */
    workspaceId?: number;
  }) => {
    const maxResults = Math.min(200, Math.max(1, params.max_results ?? 20));
    const contextLines = Math.min(
      10,
      Math.max(0, Number(params.context_lines) || 0),
    );
    const maxBytes = Math.min(
      500_000,
      Math.max(4096, Number(params.max_bytes) || 24_000),
    );
    const workspace = params.workspace || process.cwd();

    // A path that lands OUTSIDE the workspace roots the search at that exact
    // location (reads are auto-allowed anywhere); an inside relative path narrows
    // within the workspace as a glob. `include` always applies on top.
    //
    // `../sibling` counts as outside: it was previously treated as a workspace
    // glob, which quietly matched nothing instead of searching where the caller
    // asked — a silent wrong answer, worse than the error it replaced.
    // `~` is the home folder, as in a shell; ripgrep never expands it.
    const scopePath = params.path?.trim() ? expandHome(params.path) : undefined;
    const scope = scopePath?.trim()
      ? resolveToolTargetPath(workspace, scopePath)
      : null;
    const absoluteScope =
      scope && (path.isAbsolute(scopePath!.trim()) || scope.isOutsideWorkspace)
        ? scope.absPath
        : null;
    const searchRoot = absoluteScope ?? workspace;

    try {
      const filePattern = absoluteScope
        ? params.include?.trim()
        : params.include?.trim() || pathToRipgrepGlob(scopePath);
      const { groups, unreadable } = await runRipgrepSearch({
        pattern: params.pattern,
        root: searchRoot,
        workspace,
        contextLines,
        filePattern,
        caseSensitive: params.case_sensitive === true,
      });

      // Trim to the match cap in ripgrep's own order, then label each kept file
      // with its workspace-relative path for a clean, low-token result.
      let kept = 0;
      const trimmed: GrepGroup[] = [];
      for (const g of groups) {
        // A binary group carries no lines, so it neither spends the budget nor
        // may be cut off by it — dropping it here would restore the silent skip
        // that `--binary` was added to end.
        if (g.binary) {
          trimmed.push({
            file: g.file,
            matches: [],
            binary: true,
            relFile: path.relative(searchRoot, g.file).replace(/\\/g, "/"),
          });
          continue;
        }
        if (kept >= maxResults) break;
        const slice = g.matches.slice(0, Math.max(0, maxResults - kept));
        trimmed.push({
          file: g.file,
          matches: slice,
          relFile: path.relative(searchRoot, g.file).replace(/\\/g, "/"),
        });
        kept += slice.length;
      }

      // Named as glob names them: relative to where the search started.
      const unreadableLine = unreadable.length
        ? `\n\n${unreadableNote(unreadable.map((u) => (path.isAbsolute(u) ? `./${path.relative(searchRoot, u)}` : u)))}.`
        : "";

      if (trimmed.length === 0) {
        return {
          success: true,
          result: `No matches for "${params.pattern}".${unreadableLine}`,
          ui: { groups: [] },
        };
      }

      return {
        success: true,
        result:
          formatGrepGroupsForDisplay(trimmed, params.pattern, {
            perFileCap: 5,
            maxBytes,
          }).trimEnd() + unreadableLine,
        ui: {
          groups: trimmed.map((g) => ({
            file: g.file,
            matchCount: g.matches.length,
            ...(g.binary ? { binary: true } : {}),
          })),
        },
      };
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
});
