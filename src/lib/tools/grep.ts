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
};

function parseGrepOutput(output: string): GrepGroup[] {
  const groups: GrepGroup[] = [];
  const lines = output.split("\n");
  let current: GrepGroup | null = null;

  for (const line of lines) {
    if (!line.includes(":")) continue;
    const [file, lineNum, ...content] = line.split(":");
    const num = parseInt(lineNum, 10);
    if (!file || !lineNum || isNaN(num)) continue;

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
  workspace: string;
  contextLines: number;
  filePattern?: string;
  caseSensitive: boolean;
}): Promise<GrepGroup[]> {
  const { pattern, workspace, contextLines, filePattern, caseSensitive } = args;
  // `--no-require-git` + optional .atlarixignore, so ignores are honored even in
  // a non-git workspace (matches the glob tool; see ripgrep-ignore.ts).
  const ignoreArgs = await ripgrepIgnoreArgs(workspace);
  // Argv form (no shell): pattern/filePattern are model-controlled, so they must
  // never be interpolated into a shell string — `rg` receives them as literal
  // argv entries. `--` terminates option parsing so a pattern beginning with `-`
  // is treated as a pattern, not a flag.
  const buildArgs = (extra: string[]) => [
    "-n",
    "-C",
    String(contextLines),
    ...(caseSensitive ? [] : ["-i"]),
    ...(filePattern ? ["-g", filePattern] : []),
    ...ignoreArgs,
    ...extra,
    "--",
    pattern,
    workspace,
  ];

  const rgPath = await resolveRipgrepPath();
  const runOnce = async (extra: string[]) => {
    const { stdout } = await execFileAsync(rgPath, buildArgs(extra), {
      maxBuffer: 10 * 1024 * 1024,
    });
    return parseGrepOutput(stdout);
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
    if (err.code === 1) return []; // genuinely no matches
    // Retry once with PCRE2 so lookahead/backreferences/etc. actually work.
    try {
      return await runOnce(["--pcre2"]);
    } catch (e2) {
      const err2 = e2 as { code?: number; stderr?: string };
      if (err2.code === 1) return [];
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
  let out = `${total} match(es) for "${query}" across ${groups.length} file(s):\n\n`;
  for (const g of groups) {
    out += `${g.relFile ?? g.file}\n`;
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
    "Examples: grep({ pattern: \"handleLogin\" }), grep({ pattern: \"TODO|FIXME\", include: \"*.ts\" }).",
  requiresWorkspace: true,
  isCore: true,
  isReadOnly: true,
  allowInAskMode: true,
  parameters: createParameters(
    {
      pattern: stringParam("Regex (ripgrep syntax) or literal text to find."),
      path: stringParam("Optional: limit to a folder or file. Workspace-relative by default; an absolute path, or a relative one with `../`, searches outside the workspace."),
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
      max_results: numberParam("Max matching lines (default 20, max 200).", 20, 1, 200),
      max_bytes: numberParam(
        "Max UTF-8 bytes of formatted output (default 24000).",
        24_000,
        4096,
        500_000,
      ),
      workspace: { type: "string", description: "Workspace root path (auto-provided)" },
      workspaceId: { type: "number", description: "Workspace ID (auto-provided)" },
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
    workspace?: string;
    workspaceId?: number;
  }) => {
    const maxResults = Math.min(200, Math.max(1, params.max_results ?? 20));
    const contextLines = Math.min(10, Math.max(0, Number(params.context_lines) || 0));
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
    const scope =
      params.path?.trim()
        ? resolveToolTargetPath(workspace, params.path)
        : null;
    const absoluteScope =
      scope && (path.isAbsolute(params.path!.trim()) || scope.isOutsideWorkspace)
        ? scope.absPath
        : null;
    const searchRoot = absoluteScope ?? workspace;

    try {
      const filePattern = absoluteScope
        ? params.include?.trim()
        : params.include?.trim() || pathToRipgrepGlob(params.path);
      const groups = await runRipgrepSearch({
        pattern: params.pattern,
        workspace: searchRoot,
        contextLines,
        filePattern,
        caseSensitive: params.case_sensitive === true,
      });

      // Trim to the match cap in ripgrep's own order, then label each kept file
      // with its workspace-relative path for a clean, low-token result.
      let kept = 0;
      const trimmed: GrepGroup[] = [];
      for (const g of groups) {
        if (kept >= maxResults) break;
        const slice = g.matches.slice(0, Math.max(0, maxResults - kept));
        trimmed.push({
          file: g.file,
          matches: slice,
          relFile: path.relative(searchRoot, g.file).replace(/\\/g, "/"),
        });
        kept += slice.length;
      }

      if (trimmed.length === 0) {
        return {
          success: true,
          result: `No matches for "${params.pattern}".`,
          ui: { groups: [] },
        };
      }

      return {
        success: true,
        result: formatGrepGroupsForDisplay(trimmed, params.pattern, {
          perFileCap: 5,
          maxBytes,
        }),
        ui: {
          groups: trimmed.map((g) => ({
            file: g.file,
            matchCount: g.matches.length,
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
