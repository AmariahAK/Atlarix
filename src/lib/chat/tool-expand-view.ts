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

// legacy names kept: persisted sessions still contain these tool parts.
const EXPLORE_LIST_TOOLS = new Set([
  "explore_folder",
  "list_files",
  "get_repo_overview",
]);

const SEARCH_MATCH_TOOLS = new Set([
  "grep",
  "glob",
  // legacy: persisted sessions
  "search",
  "search_code",
  "grep_search",
  "semantic_search",
  "structural_search",
  "find_file",
]);

const READ_FILE_TOOLS = new Set(["read_file", "read_url"]);

const WEB_SEARCH_TOOLS = new Set(["web_search", "deep_research"]);

const RUN_COMMAND_TOOLS = new Set(["run_command", "run_shell_command"]);

const MCP_LIST_TOOLS = new Set(["list_available_mcps"]);

const MCP_CALL_TOOLS = new Set(["mcp_call"]);

const ATTACHMENT_TOOLS = new Set(["read_attachment"]);

/** Rows shown in the spreadsheet/CSV table card before "+N more". */
const MAX_TABLE_CARD_ROWS = 30;

// v11 in-app browser + WebMCP bridge
const BROWSER_TEXT_TOOLS = new Set([
  "browser_navigate",
  "browser_read_page",
  "browser_snapshot",
  "browser_click",
  "browser_fill",
]);
const BROWSER_SCREENSHOT_TOOLS = new Set(["browser_screenshot"]);
const WEBMCP_LIST_TOOLS = new Set(["list_webmcp_tools"]);
const WEBMCP_CALL_TOOLS = new Set(["call_webmcp_tool"]);

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
      /** run_command result: command line + exit code + captured output. */
      kind: "command";
      command?: string;
      exitCode?: number;
      body: string;
      isError?: boolean;
    }
  | {
      kind: "search_results";
      query: string;
      results: { title: string; url: string; snippet?: string }[];
    }
  | {
      kind: "mcp_servers";
      servers: {
        id?: number;
        name: string;
        transport?: string;
        scope?: string;
        tools: { name: string; description?: string }[];
        error?: string;
        needsOAuth?: boolean;
      }[];
      usage?: string;
      message?: string;
    }
  | {
      kind: "mcp_result";
      server: string;
      tool: string;
      body: string;
    }
  | {
      kind: "mcp_auth";
      serverId: number;
      serverName: string;
      authType: "none" | "env" | "api_key" | "oauth";
      reason: "missing" | "invalid";
      message: string;
    }
  | {
      kind: "table";
      fileName: string;
      sheetName?: string;
      headers: string[];
      rows: string[][];
      totalRows: number;
      moreCount?: number;
    }
  | {
      kind: "browser_screenshot";
      url: string;
      title: string;
      dataUrl: string;
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
): Extract<ToolExpandView, { kind: "command" }> | null {
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
  const exitRaw = payload.exit_code ?? payload.exitCode ?? payload.code;
  const exitCode =
    typeof exitRaw === "number" && Number.isFinite(exitRaw) ? exitRaw : undefined;
  const command =
    typeof payload.command === "string" && payload.command.trim()
      ? payload.command.trim()
      : undefined;
  return {
    kind: "command",
    command,
    exitCode,
    body: output.trim(),
    isError: exitCode != null && exitCode !== 0,
  };
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

function prettyMaybeJson(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return trimmed;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return trimmed;
  }
}

function buildMcpServersView(
  payload: Record<string, unknown>,
): Extract<ToolExpandView, { kind: "mcp_servers" }> | null {
  const rawServers = payload.servers;
  if (!Array.isArray(rawServers)) return null;

  const servers: Extract<ToolExpandView, { kind: "mcp_servers" }>["servers"] = [];
  for (const s of rawServers) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!name) continue;

    const tools: { name: string; description?: string }[] = [];
    if (Array.isArray(o.tools)) {
      for (const t of o.tools) {
        if (!t || typeof t !== "object") continue;
        const to = t as Record<string, unknown>;
        const tn = typeof to.name === "string" ? to.name.trim() : "";
        if (!tn) continue;
        tools.push({
          name: tn,
          description:
            typeof to.description === "string" && to.description.trim()
              ? to.description.trim()
              : undefined,
        });
      }
    }

    servers.push({
      id: typeof o.id === "number" ? o.id : undefined,
      name,
      transport: typeof o.transport === "string" ? o.transport : undefined,
      scope: typeof o.scope === "string" ? o.scope : undefined,
      tools,
      error: typeof o.error === "string" && o.error.trim() ? o.error.trim() : undefined,
      needsOAuth: o.needsOAuth === true,
    });
  }

  const message =
    typeof payload.message === "string" && payload.message.trim()
      ? payload.message.trim()
      : undefined;
  if (servers.length === 0 && !message) return null;

  return {
    kind: "mcp_servers",
    servers,
    usage:
      typeof payload.usage === "string" && payload.usage.trim()
        ? payload.usage.trim()
        : undefined,
    message,
  };
}

function buildMcpAuthView(
  payload: Record<string, unknown>,
): Extract<ToolExpandView, { kind: "mcp_auth" }> | null {
  const ar = payload.authRequired;
  if (!ar || typeof ar !== "object") return null;
  const o = ar as Record<string, unknown>;
  const serverId = typeof o.serverId === "number" ? o.serverId : null;
  const serverName = typeof o.serverName === "string" ? o.serverName : "";
  if (serverId == null || !serverName) return null;
  const authType =
    o.authType === "oauth" || o.authType === "api_key" || o.authType === "env"
      ? o.authType
      : "none";
  const reason = o.reason === "invalid" ? "invalid" : "missing";
  const message =
    typeof payload.error === "string" && payload.error.trim()
      ? payload.error.trim()
      : `${serverName} needs authentication.`;
  return { kind: "mcp_auth", serverId, serverName, authType, reason, message };
}

function buildMcpResultView(
  payload: Record<string, unknown>,
): Extract<ToolExpandView, { kind: "mcp_result" }> | null {
  const server = typeof payload.server === "string" ? payload.server.trim() : "";
  const tool = typeof payload.tool === "string" ? payload.tool.trim() : "";

  const rawResult = payload.result;
  let body = "";
  if (typeof rawResult === "string") {
    body = prettyMaybeJson(rawResult);
  } else if (rawResult != null) {
    try {
      body = JSON.stringify(rawResult, null, 2);
    } catch {
      body = String(rawResult);
    }
  }

  if (!server && !tool && !body.trim()) return null;
  return { kind: "mcp_result", server: server || "mcp", tool, body: body.trim() };
}

type AttachmentTableShape = {
  headers?: unknown;
  rows?: unknown;
  totalRows?: unknown;
};

/** read_attachment spreadsheet/CSV results carry a structured `table`. */
function buildAttachmentTableView(
  payload: Record<string, unknown>,
): Extract<ToolExpandView, { kind: "table" }> | null {
  // Single attachment spreads top-level; multi-read nests under `results`.
  let source: Record<string, unknown> | undefined;
  if (payload.table && typeof payload.table === "object") {
    source = payload;
  } else if (Array.isArray(payload.results)) {
    source = (payload.results as Record<string, unknown>[]).find(
      (r) => r && typeof r === "object" && r.table && typeof r.table === "object",
    );
  }
  const table = source?.table as AttachmentTableShape | undefined;
  if (!table || !Array.isArray(table.headers) || !Array.isArray(table.rows)) {
    return null;
  }

  const headers = (table.headers as unknown[]).map(String);
  const allRows = (table.rows as unknown[])
    .filter(Array.isArray)
    .map((r) => (r as unknown[]).map(String));
  if (headers.length === 0 && allRows.length === 0) return null;

  const rows = allRows.slice(0, MAX_TABLE_CARD_ROWS);
  const totalRows =
    typeof table.totalRows === "number" ? table.totalRows : allRows.length;
  const moreCount = Math.max(0, totalRows - rows.length) || undefined;

  return {
    kind: "table",
    fileName: String(source?.filename ?? source?.name ?? ""),
    sheetName:
      typeof source?.sheetName === "string" ? source.sheetName : undefined,
    headers,
    rows,
    totalRows,
    moreCount,
  };
}

/** read_attachment text-bearing documents (pdf/docx/pptx/odt/rtf) → snippet card. */
function buildAttachmentDocumentView(
  payload: Record<string, unknown>,
): Extract<ToolExpandView, { kind: "read_snippet" }> | null {
  const content = typeof payload.content === "string" ? payload.content : null;
  const filename =
    typeof payload.filename === "string"
      ? payload.filename
      : typeof payload.name === "string"
        ? payload.name
        : "";
  if (!content?.trim() || !filename) return null;
  const snippet = content.split("\n").slice(0, MAX_READ_LINES).join("\n");
  const { fileName, directory } = splitPathForDisplay(filename);
  return { kind: "read_snippet", path: filename, fileName, directory, snippet };
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

  if (MCP_LIST_TOOLS.has(toolName)) {
    if (typeof payload.error === "string" && payload.error.trim()) {
      return { kind: "text", body: payload.error.trim(), isError: true };
    }
    const servers = buildMcpServersView(payload);
    if (servers) return servers;
  }

  if (MCP_CALL_TOOLS.has(toolName)) {
    const authView = buildMcpAuthView(payload);
    if (authView) return authView;
    if (typeof payload.error === "string" && payload.error.trim()) {
      return { kind: "text", body: payload.error.trim(), isError: true };
    }
    const mcpResult = buildMcpResultView(payload);
    if (mcpResult) return mcpResult;
  }

  if (ATTACHMENT_TOOLS.has(toolName)) {
    const table = buildAttachmentTableView(payload);
    if (table) return table;
    const doc = buildAttachmentDocumentView(payload);
    if (doc) return doc;
  }

  if (BROWSER_SCREENSHOT_TOOLS.has(toolName)) {
    if (typeof payload.data === "string" && payload.data.length > 0) {
      return {
        kind: "browser_screenshot",
        url: typeof payload.url === "string" ? payload.url : "",
        title: typeof payload.title === "string" ? payload.title : "",
        dataUrl: `data:${typeof payload.mimeType === "string" ? payload.mimeType : "image/png"};base64,${payload.data}`,
      };
    }
    if (typeof payload.error === "string" && payload.error.trim()) {
      return { kind: "text", body: payload.error.trim(), isError: true };
    }
  }

  if (BROWSER_TEXT_TOOLS.has(toolName)) {
    if (typeof payload.error === "string" && payload.error.trim()) {
      return { kind: "text", body: payload.error.trim(), isError: true };
    }
    const parts: string[] = [];
    if (typeof payload.title === "string" && payload.title) parts.push(payload.title);
    if (typeof payload.url === "string" && payload.url) parts.push(payload.url);
    const header = parts.join(" — ");
    const body =
      typeof payload.content === "string" && payload.content.trim()
        ? payload.content
        : typeof payload.note === "string"
          ? payload.note
          : "";
    const combined = [header, body].filter(Boolean).join("\n\n");
    if (combined.trim()) return { kind: "text", body: combined };
  }

  if (WEBMCP_LIST_TOOLS.has(toolName)) {
    const tools = Array.isArray(payload.tools)
      ? (payload.tools as { name?: unknown; description?: unknown; title?: unknown }[])
      : [];
    const origin = typeof payload.origin === "string" ? payload.origin : "";
    if (tools.length > 0 && origin) {
      // Reuse the MCP servers card: one "server" per page origin.
      return {
        kind: "mcp_servers",
        servers: [
          {
            name: origin,
            transport: "webmcp",
            tools: tools
              .filter((t) => typeof t?.name === "string")
              .map((t) => ({
                name: String(t.name),
                description:
                  typeof t.description === "string" ? t.description : undefined,
              })),
          },
        ],
        usage: typeof payload.usage === "string" ? payload.usage : undefined,
      };
    }
    if (typeof payload.message === "string" && payload.message.trim()) {
      return { kind: "text", body: payload.message.trim() };
    }
  }

  if (WEBMCP_CALL_TOOLS.has(toolName)) {
    if (typeof payload.error === "string" && payload.error.trim()) {
      return { kind: "text", body: payload.error.trim(), isError: true };
    }
    if (typeof payload.result === "string" && payload.result.trim()) {
      return {
        kind: "mcp_result",
        server: typeof payload.origin === "string" ? payload.origin : "webmcp",
        tool: typeof payload.tool === "string" ? payload.tool : "",
        body: payload.result,
      };
    }
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

/**
 * v13: completed mutating tools show their meaningful detail by DEFAULT —
 * the diff for writes/edits, the output + exit code for commands, and error
 * detail for failures. Read/search results stay collapsed behind the chevron.
 * Shared by the live stream card and the hydrated/persisted card path.
 */
export function defaultOpenFor(
  view: ToolExpandView,
  status: "running" | "done" | "error",
): boolean {
  if (status === "running") return false;
  if (status === "error") return true;
  if (view.kind === "diff") return true;
  if (view.kind === "command") return true;
  if (view.kind === "text" && view.isError) return true;
  return false;
}
