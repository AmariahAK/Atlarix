import { getToolActivityLabel, getToolDoneLabel } from "@/lib/tool-activity-labels";
import type { StreamThreadToolStatus } from "@/lib/chat/stream-thread";

const WRITE_TOOLS = new Set([
  "write_file",
  "write_multiple_files",
  "edit_file",
  "search_replace",
  "replace_code",
]);

const EXPLORE_LIST_TOOLS = new Set(["explore_folder", "list_files"]);

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

const MCP_LIST_TOOLS = new Set(["list_available_mcps"]);

const MCP_CALL_TOOLS = new Set(["mcp_call"]);

const WEB_SEARCH_TOOLS = new Set(["web_search", "deep_research"]);

const PREVIEW_MAX = 300;
const READ_FILE_PREVIEW_MAX = 200;
const ACTIVITY_DETAIL_MAX = 500;

function tryParseJson(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return undefined;
  }
}

function countLines(text: string): number {
  if (!text.trim()) return 0;
  return text.split(/\r?\n/).length;
}

function capPreview(text: string, max = PREVIEW_MAX): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function capActivityDetail(text: string): string {
  return capPreview(text, ACTIVITY_DETAIL_MAX);
}

function resultToRawString(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

type ParsedEnvelope = {
  payload: Record<string, unknown>;
  error?: string;
  plainText?: string;
};

/** Unwrap tool JSON envelopes; never stringify nested objects for display. */
export function parseToolResultEnvelope(raw: string | unknown): ParsedEnvelope | null {
  if (raw == null) return null;

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      return { payload: {}, plainText: trimmed };
    }
    const parsed = tryParseJson(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { payload: {}, plainText: trimmed };
    }
    return envelopeFromObject(parsed as Record<string, unknown>);
  }

  if (typeof raw === "object" && !Array.isArray(raw)) {
    return envelopeFromObject(raw as Record<string, unknown>);
  }

  return null;
}

function envelopeFromObject(o: Record<string, unknown>): ParsedEnvelope {
  if (o.success === false) {
    const err =
      typeof o.error === "string"
        ? o.error
        : typeof o.message === "string"
          ? o.message
          : "Tool failed";
    return { payload: o, error: err };
  }

  const result = o.result;
  if (result != null && typeof result === "object" && !Array.isArray(result)) {
    const inner = result as Record<string, unknown>;
    const payload: Record<string, unknown> = { ...inner };
    for (const key of ["message", "summary", "error", "output"] as const) {
      if (typeof o[key] === "string" && typeof payload[key] !== "string") {
        payload[key] = o[key];
      }
    }
    return { payload };
  }
  if (typeof result === "string") {
    return { payload: o, plainText: result };
  }

  return { payload: o };
}

function extractShortField(payload: Record<string, unknown>): string | undefined {
  for (const key of ["message", "summary", "output"] as const) {
    const v = payload[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  if (typeof payload.result === "string" && payload.result.trim()) {
    return payload.result.trim();
  }
  if (typeof payload.error === "string" && payload.error.trim()) {
    return payload.error.trim();
  }
  return undefined;
}

function pathFromItem(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  const o = item as Record<string, unknown>;
  if (typeof o.path === "string" && o.path.trim()) return o.path.trim();
  if (typeof o.file === "string" && o.file.trim()) return o.file.trim();
  if (typeof o.name === "string" && o.name.trim()) return o.name.trim();
  return "";
}

function formatExploreListPreview(payload: Record<string, unknown>): string | undefined {
  const total =
    typeof payload.total === "number"
      ? payload.total
      : Array.isArray(payload.items)
        ? payload.items.length
        : undefined;

  const items = payload.items;
  if (!Array.isArray(items) || items.length === 0) {
    if (total != null) return `${total} item${total === 1 ? "" : "s"}`;
    return extractShortField(payload);
  }

  const filePaths: string[] = [];
  const anyPaths: string[] = [];
  for (const item of items) {
    const p = pathFromItem(item);
    if (!p) continue;
    anyPaths.push(p);
    const type = (item as Record<string, unknown>).type;
    if (type === "file" || type !== "dir") {
      filePaths.push(p);
    }
  }

  const paths = (filePaths.length > 0 ? filePaths : anyPaths).slice(0, 8);
  const count = total ?? items.length;
  if (paths.length === 0) {
    return `${count} item${count === 1 ? "" : "s"}`;
  }

  const joined = paths.join(", ");
  const more = count > paths.length ? "…" : "";
  return `${count} item${count === 1 ? "" : "s"} — ${joined}${more}`;
}

function formatSearchMatchPreview(
  payload: Record<string, unknown>,
  plainText?: string,
): string | undefined {
  const groups = payload.groups;
  if (Array.isArray(groups)) {
    let matchCount = 0;
    const files: string[] = [];
    for (const g of groups) {
      if (!g || typeof g !== "object") continue;
      const go = g as Record<string, unknown>;
      const file = typeof go.file === "string" ? go.file : "";
      const matches = go.matches;
      const n = Array.isArray(matches) ? matches.length : 0;
      matchCount += n;
      if (file) files.push(file);
    }
    const unique = [...new Set(files)].slice(0, 3);
    if (matchCount > 0) {
      const pathSuffix = unique.length ? ` — ${unique.join(", ")}` : "";
      return `${matchCount} match${matchCount === 1 ? "" : "es"} found${pathSuffix}`;
    }
  }

  const matches = payload.matches ?? payload.results;
  if (Array.isArray(matches)) {
    const files = new Set<string>();
    for (const m of matches) {
      const p = pathFromItem(m);
      if (p) files.add(p);
    }
    const n =
      typeof payload.total_matches === "number"
        ? payload.total_matches
        : typeof payload.count === "number"
          ? payload.count
          : matches.length;
    const list = [...files].slice(0, 3).join(", ");
    return list
      ? `${n} match${n === 1 ? "" : "es"} found — ${list}`
      : `${n} match${n === 1 ? "" : "es"} found`;
  }

  if (typeof payload.total_matches === "number") {
    const n = payload.total_matches;
    return `${n} match${n === 1 ? "" : "es"} found`;
  }

  if (plainText && !plainText.trim().startsWith("{")) {
    const firstLine = plainText.split(/\r?\n/).find((l) => l.trim())?.trim();
    if (firstLine && !firstLine.startsWith("{")) return capPreview(firstLine);
  }

  return undefined;
}

function formatReadFilePreview(content: string): string {
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  let out = lines.slice(0, 4).join("\n");
  if (!out.trim()) return capPreview(content.replace(/\s+/g, " ").trim(), READ_FILE_PREVIEW_MAX);
  if (out.length > READ_FILE_PREVIEW_MAX) {
    out = `${out.slice(0, READ_FILE_PREVIEW_MAX - 1)}…`;
  }
  return out;
}

function formatWritePreview(
  payload: Record<string, unknown>,
  plainText?: string,
): string {
  const resultText =
    plainText?.trim() ||
    (typeof payload.result === "string" ? payload.result : undefined);

  if (resultText) {
    const lines = countLines(resultText);
    if (lines > 0) {
      return `${lines} line${lines === 1 ? "" : "s"} written`;
    }
    if (/lines?\s+written/i.test(resultText)) {
      return capPreview(resultText.replace(/\s+/g, " ").trim());
    }
  }

  if (typeof payload.lines_written === "number") {
    const n = payload.lines_written;
    return `${n} line${n === 1 ? "" : "s"} written`;
  }

  return "File saved";
}

function formatMcpListPreview(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.error === "string" && payload.error.trim()) {
    return payload.error.trim();
  }
  const servers = payload.servers;
  if (!Array.isArray(servers)) {
    return extractShortField(payload);
  }
  if (servers.length === 0) {
    return (
      (typeof payload.message === "string" && payload.message.trim()) ||
      "No MCP servers configured"
    );
  }
  let toolCount = 0;
  for (const s of servers) {
    if (s && typeof s === "object" && Array.isArray((s as Record<string, unknown>).tools)) {
      toolCount += ((s as Record<string, unknown>).tools as unknown[]).length;
    }
  }
  const serverLabel = `${servers.length} MCP server${servers.length === 1 ? "" : "s"}`;
  return toolCount > 0
    ? `${serverLabel} · ${toolCount} tool${toolCount === 1 ? "" : "s"}`
    : serverLabel;
}

function formatMcpCallPreview(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.error === "string" && payload.error.trim()) {
    return payload.error.trim();
  }
  const server = typeof payload.server === "string" ? payload.server.trim() : "";
  const tool = typeof payload.tool === "string" ? payload.tool.trim() : "";
  if (server || tool) {
    return tool ? `${server || "mcp"}/${tool}` : server;
  }
  return extractShortField(payload);
}

function formatWebSearchPreview(payload: Record<string, unknown>): string | undefined {
  const sources = payload.sources;
  if (Array.isArray(sources)) {
    const n = sources.length;
    return `${n} result${n === 1 ? "" : "s"}`;
  }
  const findings = payload.findings;
  if (Array.isArray(findings)) {
    const n = findings.length;
    return `${n} finding${n === 1 ? "" : "s"}`;
  }
  return undefined;
}

/** Serialize tool result for expand panels (full JSON, not summarized). */
export function toolResultTextForExpand(result: unknown): string | undefined {
  if (result == null) return undefined;
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return undefined;
  }
}

/** Human-readable preview for stream tool cards and activity detail. */
export function formatToolResultPreview(
  registryName: string,
  rawDetail: string | undefined,
  status: StreamThreadToolStatus,
): string | undefined {
  if (rawDetail == null || (typeof rawDetail === "string" && !rawDetail.trim())) {
    return undefined;
  }

  const envelope = parseToolResultEnvelope(rawDetail);
  if (!envelope) return undefined;

  if (status === "error" || envelope.error) {
    const msg = envelope.error ?? extractShortField(envelope.payload) ?? "Tool failed";
    return capPreview(msg);
  }

  const payload = envelope.payload;
  const plain = envelope.plainText;

  if (EXPLORE_LIST_TOOLS.has(registryName)) {
    const s = formatExploreListPreview(payload);
    if (s) return capPreview(s);
  }

  if (SEARCH_MATCH_TOOLS.has(registryName) && !EXPLORE_LIST_TOOLS.has(registryName)) {
    const s = formatSearchMatchPreview(payload, plain);
    if (s) return capPreview(s);
  }

  if (READ_FILE_TOOLS.has(registryName)) {
    const content = plain ?? extractShortField(payload);
    if (content) return formatReadFilePreview(content);
  }

  if (WRITE_TOOLS.has(registryName)) {
    return capPreview(formatWritePreview(payload, plain));
  }

  if (MCP_LIST_TOOLS.has(registryName)) {
    const s = formatMcpListPreview(payload);
    if (s) return capPreview(s);
  }

  if (MCP_CALL_TOOLS.has(registryName)) {
    const s = formatMcpCallPreview(payload);
    if (s) return capPreview(s);
  }

  if (WEB_SEARCH_TOOLS.has(registryName)) {
    const s = formatWebSearchPreview(payload);
    if (s) return capPreview(s);
  }

  const fallback = plain ?? extractShortField(payload);
  if (fallback && !fallback.trim().startsWith("{")) {
    return capPreview(fallback);
  }

  if (status === "done") return "Done";
  return undefined;
}

/** Plain-text preview for expanded tool cards (result only, never args). */
export function formatStreamToolResultPreview(
  registryName: string,
  rawDetail: string | undefined,
  status: StreamThreadToolStatus,
): string | undefined {
  return formatToolResultPreview(registryName, rawDetail, status);
}

/** Trimmed tool output for chat:activity detail on completion (main + renderer). */
export function summarizeToolResultForActivityDetail(
  toolName: string,
  result: unknown,
  status: "done" | "error",
): string | undefined {
  const raw = resultToRawString(result);
  if (!raw.trim()) return undefined;
  const streamStatus: StreamThreadToolStatus = status === "error" ? "error" : "done";
  const preview = formatToolResultPreview(toolName, raw, streamStatus);
  if (!preview) return undefined;
  return capActivityDetail(preview);
}

export function getToolRunningSummary(registryName: string): string {
  return getToolActivityLabel(registryName);
}

/** Live sub-agent / stream line while a tool is running (includes path/query when known). */
export function formatToolStartPreview(
  registryName: string,
  toolArgs: Record<string, unknown> | undefined,
): string {
  if (!toolArgs || typeof toolArgs !== "object") {
    return getToolActivityLabel(registryName);
  }
  const path =
    (typeof toolArgs.path === "string" && toolArgs.path.trim()) ||
    (typeof toolArgs.file_path === "string" && toolArgs.file_path.trim()) ||
    (typeof toolArgs.focus_path === "string" && toolArgs.focus_path.trim()) ||
    undefined;
  const query =
    typeof toolArgs.query === "string" ? toolArgs.query.trim() : undefined;
  const command =
    typeof toolArgs.command === "string" ? toolArgs.command.trim() : undefined;
  const base = getToolActivityLabel(registryName).replace(/…$/, "");
  if (path) {
    const short = path.length > 72 ? `${path.slice(0, 69)}…` : path;
    return `${base} (${short})…`;
  }
  if (query) {
    const q = query.length > 56 ? `${query.slice(0, 53)}…` : query;
    return `${base}: ${q}…`;
  }
  if (command) {
    const c = command.length > 56 ? `${command.slice(0, 53)}…` : command;
    return `${base}: ${c}…`;
  }
  return getToolActivityLabel(registryName);
}

export function getToolCompletedSummary(registryName: string): string {
  return getToolDoneLabel(registryName);
}

export function looksLikeToolArgsJson(detail: string | undefined): boolean {
  if (!detail?.trim()) return false;
  const t = detail.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return false;
  const parsed = tryParseJson(t);
  if (!parsed || typeof parsed !== "object") return false;
  const o = parsed as Record<string, unknown>;
  return (
    "path" in o ||
    "query" in o ||
    "command" in o ||
    "file_path" in o ||
    "pattern" in o
  );
}
