import {
  formatToolResultPreview,
  parseToolResultEnvelope,
} from "@/lib/chat/stream-tool-display";
import type { StreamThreadToolStatus } from "@/lib/chat/stream-thread";

const WRITE_TOOLS = new Set([
  "write_file",
  "write_multiple_files",
  "edit_file",
  "search_replace",
  "replace_code",
  "apply_patch",
]);

const EXPLORE_LIST_TOOLS = new Set([
  "explore_folder",
  "list_files",
  "get_repo_overview",
]);

const SEARCH_MATCH_TOOLS = new Set([
  "search",
  "search_code",
  "grep",
  "grep_search",
  "semantic_search",
  "structural_search",
  "find_file",
]);

const READ_FILE_TOOLS = new Set(["read_file", "read_url"]);

const WEB_SEARCH_TOOLS = new Set(["web_search", "deep_research"]);

const RUN_COMMAND_TOOLS = new Set(["run_command", "run_shell_command"]);

const MAX_FILE_ROWS = 50;
const MAX_READ_LINES = 40;
const DIFF_CONTENT_MAX = 120_000;

export type ToolExpandFileEntry = {
  path: string;
  fileName: string;
  directory: string;
  entryType?: "file" | "dir";
};

export type ToolExpandMatchEntry = {
  path: string;
  fileName: string;
  directory: string;
  matchCount: number;
};

export type ToolExpandView =
  | { kind: "none" }
  | {
      kind: "file_list";
      total: number;
      truncated?: boolean;
      entries: ToolExpandFileEntry[];
      moreCount?: number;
    }
  | {
      kind: "match_list";
      totalMatches: number;
      files: ToolExpandMatchEntry[];
      moreCount?: number;
    }
  | {
      kind: "read_snippet";
      path: string;
      fileName: string;
      directory: string;
      lineRange?: string;
      snippet: string;
    }
  | {
      kind: "diff";
      path: string;
      fileName: string;
      operation: "create" | "update" | "delete";
      oldContent: string;
      newContent: string;
      addedCount?: number;
      removedCount?: number;
      snippetFallback?: string;
    }
  | { kind: "text"; body: string; isError?: boolean }
  | {
      kind: "search_results";
      query: string;
      results: { title: string; url: string; snippet?: string }[];
    };

export function splitPathForDisplay(fullPath: string): {
  fileName: string;
  directory: string;
} {
  const normalized = fullPath.replace(/\\/g, "/").trim();
  const slash = normalized.lastIndexOf("/");
  if (slash < 0) {
    return { fileName: normalized, directory: "." };
  }
  const fileName = normalized.slice(slash + 1) || normalized;
  const dir = normalized.slice(0, slash);
  const directory = dir ? `./${dir}` : ".";
  return { fileName, directory };
}

/** Parse formatGrepGroupsForDisplay plain-text output (legacy persisted results). */
export function parseGrepDisplayText(text: string): ToolExpandMatchEntry[] {
  const files: ToolExpandMatchEntry[] = [];
  let current: ToolExpandMatchEntry | null = null;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const fileMatch = trimmed.match(/^📄\s+(.+)$/);
    if (fileMatch) {
      if (current) files.push(current);
      const path = fileMatch[1]!.trim();
      const { fileName, directory } = splitPathForDisplay(path);
      current = { path, fileName, directory, matchCount: 0 };
      continue;
    }

    if (current && /^\d+:\s/.test(trimmed)) {
      current.matchCount += 1;
      continue;
    }

    if (current && trimmed.startsWith("... and ")) {
      const m = trimmed.match(/and (\d+) more in this file/);
      if (m) current.matchCount += Number(m[1]) || 0;
    }
  }

  if (current) files.push(current);
  return files;
}

function pathFromItem(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  const o = item as Record<string, unknown>;
  if (typeof o.path === "string" && o.path.trim()) return o.path.trim();
  if (typeof o.file === "string" && o.file.trim()) return o.file.trim();
  return "";
}

function matchCountFromGroup(g: Record<string, unknown>): number {
  if (typeof g.matchCount === "number") return g.matchCount;
  const matches = g.matches;
  if (Array.isArray(matches)) return matches.length;
  return 0;
}

function buildFileListView(
  payload: Record<string, unknown>,
): Extract<ToolExpandView, { kind: "file_list" }> | null {
  const items = payload.items;
  if (!Array.isArray(items) || items.length === 0) return null;

  const total =
    typeof payload.total === "number" ? payload.total : items.length;
  const truncated = payload.truncated === true;

  const entries: ToolExpandFileEntry[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const p = pathFromItem(item);
    if (!p) continue;
    const { fileName, directory } = splitPathForDisplay(p);
    const t = o.type;
    entries.push({
      path: p,
      fileName,
      directory,
      entryType: t === "dir" ? "dir" : t === "file" ? "file" : undefined,
    });
  }

  const slice = entries.slice(0, MAX_FILE_ROWS);
  const moreCount =
    total > slice.length ? total - slice.length : entries.length > slice.length ? entries.length - slice.length : undefined;

  return {
    kind: "file_list",
    total,
    truncated,
    entries: slice,
    moreCount: moreCount && moreCount > 0 ? moreCount : undefined,
  };
}

function buildMatchListFromGroups(
  groups: unknown[],
): Extract<ToolExpandView, { kind: "match_list" }> | null {
  const files: ToolExpandMatchEntry[] = [];
  let totalMatches = 0;

  for (const g of groups) {
    if (!g || typeof g !== "object") continue;
    const go = g as Record<string, unknown>;
    const filePath =
      typeof go.file === "string"
        ? go.file
        : typeof go.path === "string"
          ? go.path
          : "";
    if (!filePath) continue;
    const n = matchCountFromGroup(go);
    totalMatches += n;
    const { fileName, directory } = splitPathForDisplay(filePath);
    files.push({ path: filePath, fileName, directory, matchCount: n || 1 });
  }

  if (files.length === 0) return null;

  const slice = files.slice(0, MAX_FILE_ROWS);
  const moreCount = files.length > slice.length ? files.length - slice.length : undefined;

  return {
    kind: "match_list",
    totalMatches: totalMatches || files.reduce((s, f) => s + f.matchCount, 0),
    files: slice,
    moreCount,
  };
}

function buildMatchListView(
  payload: Record<string, unknown>,
  plainText?: string,
): Extract<ToolExpandView, { kind: "match_list" }> | null {
  const ui = payload.ui;
  if (ui && typeof ui === "object" && !Array.isArray(ui)) {
    const uiGroups = (ui as Record<string, unknown>).groups;
    if (Array.isArray(uiGroups)) {
      const fromUi = buildMatchListFromGroups(uiGroups);
      if (fromUi) return fromUi;
    }
  }

  if (Array.isArray(payload.groups)) {
    const fromGroups = buildMatchListFromGroups(payload.groups);
    if (fromGroups) return fromGroups;
  }

  const matches = payload.matches ?? payload.results;
  if (Array.isArray(matches)) {
    const byFile = new Map<string, number>();
    for (const m of matches) {
      const p = pathFromItem(m);
      if (p) byFile.set(p, (byFile.get(p) ?? 0) + 1);
    }
    const files: ToolExpandMatchEntry[] = [];
    for (const [path, matchCount] of byFile) {
      const { fileName, directory } = splitPathForDisplay(path);
      files.push({ path, fileName, directory, matchCount });
    }
    if (files.length > 0) {
      const totalMatches =
        typeof payload.total_matches === "number"
          ? payload.total_matches
          : files.reduce((s, f) => s + f.matchCount, 0);
      const slice = files.slice(0, MAX_FILE_ROWS);
      return {
        kind: "match_list",
        totalMatches,
        files: slice,
        moreCount: files.length > slice.length ? files.length - slice.length : undefined,
      };
    }
  }

  if (plainText && !plainText.trim().startsWith("{")) {
    const parsed = parseGrepDisplayText(plainText);
    if (parsed.length > 0) {
      if (import.meta.env?.DEV) {
        console.debug("[tool-expand] used parseGrepDisplayText fallback");
      }
      const totalMatches = parsed.reduce((s, f) => s + f.matchCount, 0);
      const slice = parsed.slice(0, MAX_FILE_ROWS);
      return {
        kind: "match_list",
        totalMatches,
        files: slice,
        moreCount: parsed.length > slice.length ? parsed.length - slice.length : undefined,
      };
    }
  }

  return null;
}

function readLineRangeFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const o = args as Record<string, unknown>;
  const offset = typeof o.offset === "number" ? o.offset : undefined;
  const limit = typeof o.limit === "number" ? o.limit : undefined;
  if (offset != null && limit != null) {
    const end = offset + limit - 1;
    return `L${offset}–${end}`;
  }
  if (typeof o.start_line === "number" && typeof o.end_line === "number") {
    return `L${o.start_line}–${o.end_line}`;
  }
  return undefined;
}

function pathFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const o = args as Record<string, unknown>;
  for (const key of ["path", "file_path"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function trimDiffContent(s: string): string {
  if (s.length <= DIFF_CONTENT_MAX) return s;
  return `${s.slice(0, DIFF_CONTENT_MAX)}\n… (truncated)`;
}

function buildWebSearchResultsView(
  payload: Record<string, unknown>,
  args?: unknown,
): Extract<ToolExpandView, { kind: "search_results" }> | null {
  const rawSources = payload.sources;
  if (!Array.isArray(rawSources) || rawSources.length === 0) return null;

  const results: { title: string; url: string; snippet?: string }[] = [];
  for (const entry of rawSources) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    const url = typeof o.url === "string" ? o.url.trim() : "";
    if (!url) continue;
    const title =
      (typeof o.title === "string" && o.title.trim()) || url;
    const snippet =
      typeof o.content === "string"
        ? o.content
        : typeof o.snippet === "string"
          ? o.snippet
          : undefined;
    results.push({ title, url, snippet });
  }
  if (results.length === 0) return null;

  let query = "";
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    if (typeof a.query === "string") query = a.query.trim();
  }

  return { kind: "search_results", query, results };
}

function buildCommandOutputView(
  payload: Record<string, unknown>,
  plainText?: string,
): Extract<ToolExpandView, { kind: "text" }> | null {
  const output =
    typeof payload.output === "string"
      ? payload.output
      : typeof payload.stdout === "string" || typeof payload.stderr === "string"
        ? [
            typeof payload.stdout === "string" ? payload.stdout : "",
            typeof payload.stderr === "string" ? payload.stderr : "",
          ]
            .filter(Boolean)
            .join("\n")
        : plainText?.trim() && !plainText.trim().startsWith("{")
          ? plainText
          : "";
  if (!output.trim()) return null;
  return { kind: "text", body: output.trim() };
}

function buildDiffView(
  payload: Record<string, unknown>,
  plainText?: string,
  args?: unknown,
): Extract<ToolExpandView, { kind: "diff" }> | null {
  const path =
    (typeof payload.path === "string" && payload.path) ||
    (typeof payload.normalizedPath === "string" && payload.normalizedPath) ||
    pathFromArgs(args) ||
    "";

  const oldContent =
    typeof payload.oldContent === "string"
      ? payload.oldContent
      : typeof payload.old_content === "string"
        ? payload.old_content
        : "";
  const newContent =
    typeof payload.newContent === "string"
      ? payload.newContent
      : typeof payload.new_content === "string"
        ? payload.new_content
        : typeof payload.content === "string"
          ? payload.content
          : plainText?.trim() && !plainText.trim().startsWith("{")
            ? plainText
            : "";

  const operationRaw = payload.operation ?? payload.type;
  const operation: "create" | "update" | "delete" =
    operationRaw === "create" || operationRaw === "delete"
      ? operationRaw
      : oldContent ? "update" : "create";

  if (path && (oldContent || newContent)) {
    const { fileName } = splitPathForDisplay(path);
    const oldLines = oldContent ? oldContent.split(/\r?\n/).length : 0;
    const newLines = newContent ? newContent.split(/\r?\n/).length : 0;
    return {
      kind: "diff",
      path,
      fileName,
      operation,
      oldContent: trimDiffContent(oldContent),
      newContent: trimDiffContent(newContent),
      addedCount: Math.max(0, newLines - (operation === "create" ? 0 : oldLines)),
      removedCount: operation === "delete" ? oldLines : Math.max(0, oldLines - newLines),
    };
  }

  const diff = payload.diff;
  if (diff && typeof diff === "object" && !Array.isArray(diff)) {
    const d = diff as Record<string, unknown>;
    const added =
      typeof d.added === "number"
        ? d.added
        : typeof d.lines_added === "number"
          ? d.lines_added
          : undefined;
    const removed =
      typeof d.removed === "number"
        ? d.removed
        : typeof d.lines_removed === "number"
          ? d.lines_removed
          : undefined;
    const snippet =
      typeof d.new_snippet === "string"
        ? d.new_snippet
        : typeof d.snippet === "string"
          ? d.snippet
          : undefined;
    if (path && (added != null || removed != null || snippet)) {
      const { fileName } = splitPathForDisplay(path);
      return {
        kind: "diff",
        path,
        fileName,
        operation: "update",
        oldContent: typeof d.old_snippet === "string" ? d.old_snippet : "",
        newContent: typeof d.new_snippet === "string" ? d.new_snippet : snippet ?? "",
        addedCount: added,
        removedCount: removed,
        snippetFallback: snippet,
      };
    }
  }

  return null;
}

function buildReadSnippetView(
  payload: Record<string, unknown>,
  plainText: string | undefined,
  args?: unknown,
): Extract<ToolExpandView, { kind: "read_snippet" }> | null {
  const content = plainText ?? (typeof payload.result === "string" ? payload.result : "");
  if (!content.trim()) return null;

  const path = pathFromArgs(args) ?? pathFromItem(payload) ?? "file";
  const { fileName, directory } = splitPathForDisplay(path);
  const lines = content.split(/\r?\n/);
  const snippet = lines.slice(0, MAX_READ_LINES).join("\n");
  const truncated = lines.length > MAX_READ_LINES;

  return {
    kind: "read_snippet",
    path,
    fileName,
    directory,
    lineRange: readLineRangeFromArgs(args),
    snippet: truncated ? `${snippet}\n…` : snippet,
  };
}

export function buildToolExpandView(
  toolName: string,
  args: unknown,
  resultText: string | undefined,
  status: StreamThreadToolStatus | "success" | "error" | "running",
): ToolExpandView {
  const streamStatus: StreamThreadToolStatus =
    status === "running"
      ? "running"
      : status === "error"
        ? "error"
        : "done";

  if (streamStatus === "running") return { kind: "none" };
  if (!resultText?.trim()) return { kind: "none" };

  const envelope = parseToolResultEnvelope(resultText);
  if (!envelope) return { kind: "none" };

  if (streamStatus === "error" || envelope.error) {
    const msg =
      envelope.error ??
      (typeof envelope.payload.message === "string"
        ? envelope.payload.message
        : "Tool failed");
    return { kind: "text", body: msg, isError: true };
  }

  const payload = envelope.payload;
  const plain = envelope.plainText;

  if (EXPLORE_LIST_TOOLS.has(toolName)) {
    const fileList = buildFileListView(payload);
    if (fileList) return fileList;
  }

  if (SEARCH_MATCH_TOOLS.has(toolName)) {
    const matchList = buildMatchListView(payload, plain);
    if (matchList) return matchList;
  }

  if (READ_FILE_TOOLS.has(toolName)) {
    const read = buildReadSnippetView(payload, plain, args);
    if (read) return read;
  }

  if (WRITE_TOOLS.has(toolName)) {
    const diff = buildDiffView(payload, plain, args);
    if (diff) return diff;
  }

  if (WEB_SEARCH_TOOLS.has(toolName)) {
    const search = buildWebSearchResultsView(payload, args);
    if (search) return search;
  }

  if (RUN_COMMAND_TOOLS.has(toolName)) {
    const cmd = buildCommandOutputView(payload, plain);
    if (cmd) return cmd;
  }

  const preview = formatToolResultPreview(toolName, resultText, streamStatus);
  if (preview && !preview.trim().startsWith("{")) {
    return { kind: "text", body: preview };
  }

  const short =
    typeof payload.message === "string"
      ? payload.message
      : plain && !plain.trim().startsWith("{")
        ? plain.slice(0, 2000)
        : undefined;
  if (short?.trim()) return { kind: "text", body: short.trim() };

  return { kind: "none" };
}

export function isToolExpandable(view: ToolExpandView): boolean {
  return view.kind !== "none";
}
