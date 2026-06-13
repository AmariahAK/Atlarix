/**
 * `grep` — text/regex content search via ripgrep (v13; extracted from the
 * deleted unified `search` tool's text mode — the renderer match-list card
 * keys off the same `ui.groups` payload shape).
 */

import { exec } from "child_process";
import { promisify } from "util";
import * as path from "node:path";
import { truncateUtf8ByBytes } from "@/lib/truncate";
import {
  rankGrepHitsByBlueprint,
  suggestClosestIndexedSymbols,
} from "@/lib/blueprint/grep-blueprint-reranker";
import { ensureSymbolIndex, findEnclosingSymbol } from "@/lib/index/ctags-index";
import type { SymbolRecord } from "@/lib/index/symbol-types";
import {
  ToolRegistry,
  createParameters,
  stringParam,
  booleanParam,
  numberParam,
} from "./registry";

const execAsync = promisify(exec);

type GrepGroup = {
  file: string;
  matches: { line: number; content: string }[];
  /** Workspace-relative path (set during symbol annotation). */
  relFile?: string;
  /** Enclosing function/class of the file's top match (zoekt-style context). */
  symbol?: SymbolRecord | null;
};

/** Compact, readable label for an enclosing symbol (e.g. `Class.method`). */
function symbolLabel(s: SymbolRecord): string {
  return s.scope ? `${s.scope}.${s.name}` : s.name;
}

/**
 * Annotate each grep group with its workspace-relative path and the symbol
 * enclosing its top match, so results read zoekt-style ("the match is inside
 * `UserRegistrationView.create`"). Degrades silently (groups returned unchanged)
 * when the symbol index is cold/unavailable — grep must never get worse.
 */
async function annotateWithSymbols(
  groups: GrepGroup[],
  workspaceRootAbs: string,
): Promise<GrepGroup[]> {
  try {
    const cache = await ensureSymbolIndex(workspaceRootAbs);
    for (const g of groups) {
      g.relFile = path.relative(workspaceRootAbs, g.file).replace(/\\/g, "/");
      const topLine = g.matches[0]?.line;
      g.symbol =
        topLine != null ? findEnclosingSymbol(cache, g.relFile, topLine) : null;
    }
  } catch {
    /* no symbol index — leave groups unannotated */
  }
  return groups;
}

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
  const caseFlag = caseSensitive ? "" : "-i";
  const escaped = pattern.replace(/"/g, '\\"');
  let command = `rg "${escaped}" "${workspace}" -n -C ${contextLines} ${caseFlag}`;
  if (filePattern) command += ` -g "${filePattern}"`;

  try {
    const { stdout } = await execAsync(command, { maxBuffer: 10 * 1024 * 1024 });
    return parseGrepOutput(stdout);
  } catch {
    return [];
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
  let out = `${total} match(es) for "${query}" across ${groups.length} file(s), most relevant first:\n\n`;
  for (const g of groups) {
    const head = g.relFile ?? g.file;
    out += g.symbol ? `${head}  › ${symbolLabel(g.symbol)}\n` : `${head}\n`;
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
    "Search file CONTENTS with a regex (ripgrep). Returns sharp, low-token results: the most relevant " +
    "files first (ranked by Blueprint, the codebase's retrieval index), each annotated with the enclosing " +
    "function/class so you can jump straight to the symbol. Raise max_results for a wider sweep. " +
    "Use glob to find files by NAME; use get_blueprint for structural/architecture questions. " +
    "Examples: grep({ pattern: \"handleLogin\" }), grep({ pattern: \"TODO|FIXME\", include: \"*.ts\" }).",
  requiresWorkspace: true,
  isCore: true,
  isReadOnly: true,
  allowInAskMode: true,
  parameters: createParameters(
    {
      pattern: stringParam("Regex (ripgrep syntax) or literal text to find."),
      path: stringParam("Optional: limit to a folder or file (workspace-relative)."),
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

    try {
      const filePattern =
        params.include?.trim() || pathToRipgrepGlob(params.path);
      const groups = await runRipgrepSearch({
        pattern: params.pattern,
        workspace,
        contextLines,
        filePattern,
        caseSensitive: params.case_sensitive === true,
      });

      // Blueprint is the retrieval substrate: reorder file groups by structural
      // relevance BEFORE the cap, so the most relevant files survive truncation.
      const ranked = await rankGrepHitsByBlueprint(groups, {
        workspaceId: params.workspaceId,
        workspaceRootAbs: params.workspace,
        query: params.pattern,
      });

      let kept = 0;
      const trimmed: GrepGroup[] = [];
      for (const g of ranked) {
        if (kept >= maxResults) break;
        const slice = g.matches.slice(0, Math.max(0, maxResults - kept));
        trimmed.push({ file: g.file, matches: slice });
        kept += slice.length;
      }

      // Annotate each kept file with the symbol enclosing its top match
      // (zoekt-style) so the model can jump straight to the function/class.
      await annotateWithSymbols(trimmed, workspace);

      // v13.2: zero hits → Blueprint lexical suggestions instead of a dead
      // end (fires only on misses; prevents a wasted retry round).
      if (trimmed.length === 0) {
        const suggestions = await suggestClosestIndexedSymbols({
          workspaceId: params.workspaceId,
          workspaceRootAbs: params.workspace,
          query: params.pattern,
        });
        return {
          success: true,
          result: `No matches for "${params.pattern}".${
            suggestions ? `\n\n${suggestions}` : ""
          }`,
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
            ...(g.symbol
              ? { enclosingSymbol: { name: symbolLabel(g.symbol), kind: g.symbol.kind } }
              : {}),
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
