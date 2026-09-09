import {
  getToolActivityLabel,
  getToolActivityLabelWithArgs,
  getToolDoneLabel,
} from "@/lib/tool-activity-labels";
import type { StreamThreadToolStatus } from "@/lib/chat/stream-thread";
import { computeDiffHunks } from "@/lib/diff/compose-hunks";
import { stripUntrustedDataEnvelope } from "@/lib/streaming/untrusted-data";

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

/**
 * Is this string raw JSON rather than something worth showing a user?
 *
 * The generic fallback used to reject only strings STARTING with `{`, which let
 * any mid-object FRAGMENT through — and `capPreview` then cut it at 300 chars,
 * mid-token. That is the shape documented at tool-expand-view.ts:44-51 for
 * `subagents`/`background_jobs`, and it recurs for every tool that has no
 * dedicated branch. Catching the fragment too closes the class rather than one
 * instance.
 *
 * Detects a whole object/array, or the `","key":"` / `"key":` punctuation that
 * only appears when a serialised object has been sliced open. Ordinary prose
 * that merely quotes a word never matches, because the colon-after-quote pair
 * is required.
 */
export function looksLikeRawJson(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.startsWith("{") || t.startsWith("[")) return true;
  return /(^|,)\s*"[A-Za-z_$][\w$]*"\s*:/.test(t);
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
  /**
   * `success: false` that is NOT a failure — the call was declined or had
   * nothing to do. Rendered as ordinary text rather than a red error.
   */
  notice?: string;
};

/** Unwrap tool JSON envelopes; never stringify nested objects for display. */
export function parseToolResultEnvelope(
  raw: string | unknown,
): ParsedEnvelope | null {
  if (raw == null) return null;

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      return { payload: {}, plainText: stripUntrustedDataEnvelope(trimmed) };
    }
    const parsed = tryParseJson(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { payload: {}, plainText: stripUntrustedDataEnvelope(trimmed) };
    }
    return envelopeFromObject(parsed as Record<string, unknown>);
  }

  if (typeof raw === "object" && !Array.isArray(raw)) {
    return envelopeFromObject(raw as Record<string, unknown>);
  }

  return null;
}

/**
 * Fields a tool may use to explain itself, in the order they are preferred.
 *
 * The old chain was `error` then `message` then the literal string
 * **"Tool failed"** — and two very common results carry neither. OBSERVED
 * 2026-09-02, both of them the system working CORRECTLY and reported as a
 * failure with no reason:
 *
 *   compress_context → {success:false, status:"noop", reason, summary:
 *     "Already compact: history is 7474 tokens (~39% of the 19200-token usable
 *     budget) — nothing worth compacting. No action needed."}
 *
 *   the loop guard → {success:false, loop_guidance: "You have made this exact
 *     read_url call 3 times in a row with identical input… This call was NOT
 *     executed. Do not repeat it."}
 *
 * Both wrote a better explanation than anything the UI could invent, and both
 * displayed as "Tool failed". A generic fallback string is the worst possible
 * answer here: it is not just uninformative, it asserts something untrue.
 */
const EXPLANATION_FIELDS = [
  "error",
  "message",
  // The two that were being discarded.
  "loop_guidance",
  "summary",
  "reason",
  // Used by the browser/mobile act tools and several others.
  "detail",
  "note",
] as const;

/**
 * Values that are PLACEHOLDERS, not explanations.
 *
 * `ToolRegistry.execute`'s failure path fills these in when the tool did not
 * supply its own: `error: fail.error ?? "TOOL_ERROR"` and
 * `message: fail.message ?? "Tool returned an error"`. They are sentinels for
 * the model's benefit, and showing either to a person is no better than "Tool
 * failed" — it is worse, because it looks like a real error code.
 *
 * Skipping them lets the chain fall through to the field the tool actually
 * wrote, which is how the native path reaches the compactor's own "Already
 * compact: …" instead of the string "TOOL_ERROR".
 */
const PLACEHOLDER_EXPLANATIONS = new Set([
  "TOOL_ERROR",
  "Tool returned an error",
  "Tool failed",
]);

function firstExplanation(o: Record<string, unknown>): string | undefined {
  let placeholder: string | undefined;
  for (const key of EXPLANATION_FIELDS) {
    const v = o[key];
    if (typeof v !== "string" || !v.trim()) continue;
    const text = v.trim();
    if (PLACEHOLDER_EXPLANATIONS.has(text)) {
      // Remembered, not returned: if NOTHING else explains the failure, a
      // sentinel still beats an empty card.
      placeholder ??= text;
      continue;
    }
    return text;
  }
  return placeholder;
}

/**
 * `success: false` does NOT always mean something went wrong.
 *
 * A no-op ("nothing worth compacting") and a declined call (the loop guard) both
 * report `success: false` because from the MODEL's point of view the work did
 * not happen — which is the right signal for the model and the wrong one for a
 * red error card. They are distinguishable: `status: "noop"` and the presence of
 * `loop_guidance` are explicit markers, not guesses.
 */
function isNotAFailure(o: Record<string, unknown>): boolean {
  if (o.status === "noop") return true;
  if (typeof o.loop_guidance === "string" && o.loop_guidance.trim())
    return true;
  return false;
}

function envelopeFromObject(o: Record<string, unknown>): ParsedEnvelope {
  if (o.success === false) {
    const explanation = firstExplanation(o);
    if (isNotAFailure(o)) {
      // Not an error: keep the payload so a tool-specific card can still render,
      // and carry the explanation as a notice rather than an error.
      return { payload: o, notice: explanation ?? "Nothing to do." };
    }
    return { payload: o, error: explanation ?? "Tool failed" };
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
    return { payload: o, plainText: stripUntrustedDataEnvelope(result) };
  }

  return { payload: o };
}

function extractShortField(
  payload: Record<string, unknown>,
): string | undefined {
  for (const key of ["message", "summary", "output"] as const) {
    const v = payload[key];
    if (typeof v === "string" && v.trim()) {
      return stripUntrustedDataEnvelope(v).trim();
    }
  }
  if (typeof payload.result === "string" && payload.result.trim()) {
    return stripUntrustedDataEnvelope(payload.result).trim();
  }
  if (typeof payload.error === "string" && payload.error.trim()) {
    return stripUntrustedDataEnvelope(payload.error).trim();
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

function formatExploreListPreview(
  payload: Record<string, unknown>,
): string | undefined {
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
    const firstLine = plainText
      .split(/\r?\n/)
      .find((l) => l.trim())
      ?.trim();
    if (firstLine && !firstLine.startsWith("{")) return capPreview(firstLine);
  }

  return undefined;
}

/**
 * v10.1: read results summarize to ONE status line ("Read src/auth.ts — lines
 * 1-272 (complete)") instead of leaking file content into sub-agent progress
 * lines and tool labels. Parses the standard read_file header.
 */
function formatReadFilePreview(content: string): string {
  const pathMatch = content.match(/^File:\s*(.+)$/m);
  if (pathMatch) {
    const path = pathMatch[1].trim();
    const short = path.length > 64 ? `…${path.slice(-61)}` : path;
    const linesMatch = content.match(/^Lines:\s*(.+)$/m);
    if (linesMatch) {
      return `Read ${short} — lines ${linesMatch[1].trim()}`;
    }
    const totalMatch = content.match(
      /^Total lines:\s*(\d+)\s*\|\s*Showing:\s*(\d+)/m,
    );
    if (totalMatch) {
      return `Read ${short} — ${totalMatch[1]} lines (showing ${totalMatch[2]})`;
    }
    return `Read ${short}`;
  }
  // Non-file reads (URLs etc.): first non-empty line only, capped.
  const firstLine = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return capPreview(
    firstLine ?? content.replace(/\s+/g, " ").trim(),
    READ_FILE_PREVIEW_MAX,
  );
}

/**
 * Pull added/removed line counts from a write/edit result envelope, tolerant of
 * both the legacy top-level shape and the nested `diff` shape emitted by the
 * edit_file operations (replace/insert/delete). Returns undefined for a count
 * that isn't present so the caller can fall back. Tool/provider-agnostic — only
 * reads numeric fields, never assumes a specific tool name or provider.
 */
function extractLineCounts(payload: Record<string, unknown>): {
  added?: number;
  removed?: number;
} {
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const diff =
    payload.diff && typeof payload.diff === "object"
      ? (payload.diff as Record<string, unknown>)
      : undefined;
  const added =
    num(payload.added) ??
    num(diff?.added) ??
    num(payload.lines_added) ??
    num(diff?.lines_added);
  const removed =
    num(payload.removed) ??
    num(diff?.removed) ??
    num(payload.lines_removed) ??
    num(diff?.lines_removed);
  return { added, removed };
}

function formatWritePreview(
  payload: Record<string, unknown>,
  plainText?: string,
): string {
  // The result carries tiny `added`/`removed` line counts (not content — that
  // lives in the tool-call args). They may be top-level (legacy write results)
  // or nested under `diff` with operation-specific names: replace →
  // {added,removed}, insert → {lines_added}, delete → {lines_removed}
  // (src/lib/tools/edit.ts). Read whichever is present for the +/- summary;
  // without this the card falls through to counting lines of the status string
  // and always shows "1 line written".
  const { added, removed } = extractLineCounts(payload);
  if (added != null || removed != null) {
    const a = added ?? 0;
    const r = removed ?? 0;
    if (r === 0) return `+${a}`;
    if (a === 0) return `-${r}`;
    return `+${a} -${r}`;
  }

  // Legacy fallback: older results echoed the content; derive the summary from it.
  const newContent =
    typeof payload.newContent === "string"
      ? payload.newContent
      : typeof payload.content === "string"
        ? payload.content
        : undefined;
  if (newContent !== undefined) {
    const oldContent =
      typeof payload.oldContent === "string" ? payload.oldContent : "";
    const isCreate =
      payload.operation === "create" ||
      (!oldContent && payload.operation !== "update");
    if (isCreate) {
      const n = newContent ? newContent.split(/\r?\n/).length : 0;
      return `+${n}`;
    }
    try {
      const hunks = computeDiffHunks(oldContent, newContent, 0);
      const added = hunks.reduce((a, h) => a + h.addedCount, 0);
      const removed = hunks.reduce((a, h) => a + h.removedCount, 0);
      if (added || removed) return `+${added} -${removed}`;
      return "no changes";
    } catch {
      /* fall through to legacy summary */
    }
  }

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

function formatMcpListPreview(
  payload: Record<string, unknown>,
): string | undefined {
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
    if (
      s &&
      typeof s === "object" &&
      Array.isArray((s as Record<string, unknown>).tools)
    ) {
      toolCount += ((s as Record<string, unknown>).tools as unknown[]).length;
    }
  }
  const serverLabel = `${servers.length} MCP server${servers.length === 1 ? "" : "s"}`;
  return toolCount > 0
    ? `${serverLabel} · ${toolCount} tool${toolCount === 1 ? "" : "s"}`
    : serverLabel;
}

function formatMcpCallPreview(
  payload: Record<string, unknown>,
): string | undefined {
  if (typeof payload.error === "string" && payload.error.trim()) {
    return payload.error.trim();
  }
  const server =
    typeof payload.server === "string" ? payload.server.trim() : "";
  const tool = typeof payload.tool === "string" ? payload.tool.trim() : "";
  if (server || tool) {
    return tool ? `${server || "mcp"}/${tool}` : server;
  }
  return extractShortField(payload);
}

function formatWebSearchPreview(
  payload: Record<string, unknown>,
): string | undefined {
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
  if (
    rawDetail == null ||
    (typeof rawDetail === "string" && !rawDetail.trim())
  ) {
    return undefined;
  }

  const envelope = parseToolResultEnvelope(rawDetail);
  if (!envelope) return undefined;

  if (status === "error" || envelope.error) {
    const msg =
      envelope.error ?? extractShortField(envelope.payload) ?? "Tool failed";
    const path =
      typeof envelope.payload.path === "string" && envelope.payload.path.trim()
        ? envelope.payload.path.trim()
        : undefined;
    return capPreview(path ? `${msg} (${path})` : msg);
  }

  const payload = envelope.payload;
  const plain = envelope.plainText;

  if (EXPLORE_LIST_TOOLS.has(registryName)) {
    const s = formatExploreListPreview(payload);
    if (s) return capPreview(s);
  }

  if (
    SEARCH_MATCH_TOOLS.has(registryName) &&
    !EXPLORE_LIST_TOOLS.has(registryName)
  ) {
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
  if (fallback && !looksLikeRawJson(fallback)) {
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
  const streamStatus: StreamThreadToolStatus =
    status === "error" ? "error" : "done";
  const preview = formatToolResultPreview(toolName, raw, streamStatus);
  if (!preview) return undefined;
  return capActivityDetail(preview);
}

export function getToolRunningSummary(
  registryName: string,
  args?: Record<string, unknown> | null,
): string {
  return args
    ? getToolActivityLabelWithArgs(registryName, args)
    : getToolActivityLabel(registryName);
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
  const pattern =
    (registryName === "grep" || registryName === "glob") &&
    typeof toolArgs.pattern === "string"
      ? toolArgs.pattern.trim()
      : undefined;
  const command =
    typeof toolArgs.command === "string" ? toolArgs.command.trim() : undefined;
  const base = getToolActivityLabel(registryName).replace(/…$/, "");
  if (pattern) {
    const p = pattern.length > 56 ? `${pattern.slice(0, 53)}…` : pattern;
    return `${base}: ${p}…`;
  }
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

/**
 * A completed call that did NOTHING, named as such.
 *
 * `compress_context` on an already-small history returns
 * `{success:false, status:"noop", summary:"Already compact: …"}` — a correct
 * outcome — and the label map turned that into **"Context compacted"**, which
 * is the one thing that did not happen. Observed alongside a red "Tool failed"
 * body, so the row managed to be wrong in both directions at once.
 *
 * "Context already compact" is not new wording: it is what the compaction banner
 * has said for this case since v14.8.11 (see `emitModelCompactionActivity`), and
 * reusing it keeps the two surfaces from drifting.
 *
 * Narrow ON PURPOSE. `status: "noop"` is a contract only `compress_context`
 * declares; guessing at "did anything happen" from any other result would be
 * exactly the kind of inference that produces a confidently wrong label.
 */
export function noopSummary(
  toolName: string,
  resultText?: string,
): string | null {
  if (toolName !== "compress_context" || !resultText?.trim()) return null;
  try {
    const o = JSON.parse(resultText) as { status?: unknown };
    return o?.status === "noop" ? "Context already compact" : null;
  } catch {
    return null;
  }
}

export function getToolCompletedSummary(
  registryName: string,
  args?: Record<string, unknown> | null,
): string {
  return getToolDoneLabel(registryName, args);
}

/**
 * Summary for a tool call that FAILED.
 *
 * The completed summary is past-tense success prose — "Found files matching
 * ../telios/*", "Searched for X" — which read beside the call's own error text is a
 * contradiction the user has to resolve themselves. Worse, the card's icon is driven by
 * status while the words were not, so a failed call could show a green tick and an
 * accomplishment.
 *
 * Names the ATTEMPT instead, reusing the running label (present participle) with its
 * arg-aware detail intact, so a failed `glob` still shows which pattern was tried. The
 * error itself is already rendered by the card; this must not duplicate or paraphrase it.
 */
export function getToolFailedSummary(
  registryName: string,
  args?: Record<string, unknown> | null,
): string {
  const attempt = getToolRunningSummary(registryName, args)
    // Running labels are written with a trailing ellipsis for live activity ("Searching
    // code…"); a settled failure is not still in progress.
    .replace(/[…]+$/u, "")
    .trim();
  return attempt ? `Failed: ${attempt}` : "Tool failed";
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
