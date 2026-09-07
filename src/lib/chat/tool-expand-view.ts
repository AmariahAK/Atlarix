import {
  formatToolResultPreview,
  looksLikeRawJson,
  parseToolResultEnvelope,
} from "@/lib/chat/stream-tool-display";
import type { StreamThreadToolStatus } from "@/lib/chat/stream-thread";
import type { DiffHunk } from "@/lib/diff/compose-hunks";
import { stripUntrustedDataEnvelope } from "@/lib/streaming/untrusted-data";
import {
  parsePlanChecklist,
  type PlanStepState,
} from "@/lib/tasks/plan-checklist";
import {
  extractDelegationDisplaySummary,
  extractDelegationError,
  extractDelegationScope,
} from "@/lib/chat/subagent-summary";

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
  // Emits the same `ui.groups` {file, matchCount} shape, with `file` reading
  // "<session> · turn N · role" instead of a path.
  "session_search",
  // legacy: persisted sessions
  "search",
  "search_code",
  "grep_search",
  "semantic_search",
  "find_file",
]);

const READ_FILE_TOOLS = new Set(["read_file", "read_url"]);

const WEB_SEARCH_TOOLS = new Set(["web_search", "deep_research"]);

const RUN_COMMAND_TOOLS = new Set(["run_command", "run_shell_command"]);

/**
 * Tools that hand back a LOG TAIL in `output` — a background job's stdout or a
 * sub-agent's narration. Structurally identical to command output, so they get
 * the same scrollable card.
 *
 * Without this they fell through to the generic tail, where
 * `formatToolResultPreview` -> `extractShortField` picks `output` and
 * `capPreview` slices it at 300 chars — so the card showed a log cut
 * mid-token and offered no way to see the rest.
 */
const AGENT_LOG_TOOLS = new Set(["subagents", "background_jobs"]);

/** Sub-agent delegation — its result is a markdown report, not machine output. */
const DELEGATION_TOOLS = new Set(["task"]);

const PLAN_TOOLS = new Set(["plan"]);

/**
 * Plan card: status, progress, and the checklist itself.
 *
 * `plan` had no branch at all, so every call fell to the generic tail and showed
 * one line ("Plan updated.") or, before its results carried a `message`, a bare
 * "Done" — the worst-rendered tool in the app despite having the best structured
 * data. Reuses `parsePlanChecklist` (pure, renderer-safe) and the existing
 * `text` kind, so no new view type or renderer work is needed.
 */
/**
 * `task` (sub-agent delegation).
 *
 * `task` had NO branch, so it fell past every tool family to the generic tail and
 * was shown as a ~300-char preview slice of the raw envelope — the sub-agent's whole
 * report, reduced to a cut-off fragment of `{"success":true,"result":"<task …`.
 *
 * The body is the sub-agent's markdown report, so it renders as markdown. A still-
 * running (backgrounded / auto-promoted) task keeps its status line: the envelope
 * says `state="running"`, and presenting that as a finished report would be a lie.
 */
function buildDelegationView(
  payload: Record<string, unknown>,
  plain: string | undefined,
): ToolExpandView | null {
  const raw =
    typeof payload.result === "string" && payload.result.trim()
      ? payload.result
      : (plain ?? "");
  if (!raw.trim()) return null;

  const { summary, isError, isRunning } = extractDelegationDisplaySummary(
    payload,
    raw,
  );
  const err = extractDelegationError(raw);
  const body = (err ?? summary).trim();
  if (!body) return null;

  const scope = extractDelegationScope(raw);
  const header = [
    scope,
    isRunning ? "still running — result arrives automatically" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    kind: "text",
    body: header ? `**${header}**\n\n${body}` : body,
    isError: isError || Boolean(err),
    markdown: true,
  };
}

function buildPlanView(payload: Record<string, unknown>): ToolExpandView | null {
  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  const progress = typeof payload.progress === "string" ? payload.progress.trim() : "";
  const planStatus = typeof payload.planStatus === "string" ? payload.planStatus.trim() : "";
  const content =
    typeof payload.contentPreview === "string"
      ? payload.contentPreview
      : typeof payload.content === "string"
        ? payload.content
        : "";

  const header = [message || undefined, planStatus || undefined, progress || undefined]
    .filter(Boolean)
    .join(" · ");
  if (!header && !content) return null;

  const steps = content ? parsePlanChecklist(content) : [];
  if (steps.length === 0) return header ? { kind: "text", body: header } : null;

  // ASCII markers, per the output-style rule that the UI supplies its own icons.
  const marks: Record<PlanStepState, string> = {
    done: "[x]",
    in_progress: "[~]",
    blocked: "[!]",
    external: "[@]",
    todo: "[ ]",
  };
  const lines = steps.map((s) => `${marks[s.state] ?? "[ ]"} ${s.text}`);

  // contentPreview is capped at 400 chars upstream, so the checklist can be cut
  // mid-way. Say so rather than implying the plan is shorter than it is.
  const total = Number.parseInt(progress.split("/")[1] ?? "", 10);
  if (Number.isFinite(total) && total > steps.length) {
    lines.push(`… ${total - steps.length} more`);
  }

  return { kind: "text", body: [header, "", ...lines].filter((l) => l !== undefined).join("\n") };
}

const MCP_LIST_TOOLS = new Set(["list_available_mcps"]);

const MCP_CALL_TOOLS = new Set(["mcp_call"]);

const ATTACHMENT_TOOLS = new Set(["read_attachment"]);

/** Rows shown in the spreadsheet/CSV table card before "+N more". */
const MAX_TABLE_CARD_ROWS = 30;

// v11 in-app browser + WebMCP bridge
// `browser` is the consolidated act tool; the retired names stay so a reloaded
// session's stored rows still render their cards.
const BROWSER_TEXT_TOOLS = new Set([
  "browser",
  "browser_navigate",
  "browser_inspect",
  "browser_interact",
  "browser_find",
  "browser_tabs",
  "browser_batch",
  // Legacy tool names (pre-v13.8) kept so persisted sessions still render.
  "browser_read_page",
  "browser_snapshot",
  "browser_click",
  "browser_fill",
  // v14.41: the mobile pair reads and acts on an emulator. Its text results
  // (hierarchy, logs, device list) render in the same card as the browser's.
  "mobile_inspect",
  "mobile",
]);
// browser_inspect(mode:"screenshot") returns a PNG payload; the screenshot
// block below guards on `payload.data`, so non-screenshot inspect results fall
// through to the text block. "browser_screenshot" stays for old sessions.
// This set is NAME-keyed, unlike the model-facing image path (extractImageMedia
// gates on the SHAPE of the result). So a PNG-returning tool gets no screenshot
// card until it is listed here — the renderer dispatches on `view.kind`, so
// nothing else is needed.
const BROWSER_SCREENSHOT_TOOLS = new Set([
  "browser_inspect",
  "browser_screenshot",
  "mobile_inspect",
]);
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
  /** Enclosing function/class of the file's top match (grep symbol annotation). */
  enclosingSymbol?: { name: string; kind: string };
  /**
   * ripgrep matched but would not print the lines (the file holds a NUL byte).
   * The row must say so rather than borrow the `matchCount: n || 1` fallback,
   * which would show "1 match" for a match nobody can see.
   */
  binary?: boolean;
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
      /** First line of the read range — used to jump-to-line on open. */
      startLine?: number;
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
      /**
       * Hunks computed in MAIN (see permission-ui.ts). Passing them through
       * keeps a Myers diff off the UI thread; absent, SmartDiffView computes
       * locally exactly as before.
       */
      precomputedHunks?: DiffHunk[];
      snippetFallback?: string;
    }
  /**
   * `markdown: true` renders the body through the chat markdown renderer instead of
   * as preformatted text. Set it whenever the body is authored PROSE rather than
   * machine output — a sub-agent's summary is markdown (headings, bullets, fences)
   * and rendered raw it read as an unstyled blob. A flag on the existing kind rather
   * than a new kind, so every text-shaped tool can opt in.
   */
  | { kind: "text"; body: string; isError?: boolean; markdown?: boolean }
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
    }
  | {
      // Antigravity/Codex-style session record: the ordered list of what the
      // agent did in the in-app browser, with an optional final screenshot.
      kind: "browser_recording";
      steps: { type: string; detail: string; url?: string }[];
      url?: string;
      title?: string;
      dataUrl?: string;
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
    const binary = go.binary === true;
    // A binary group reports no lines, so counting it would inflate the header
    // with matches the list cannot show.
    if (!binary) totalMatches += n;
    const { fileName, directory } = splitPathForDisplay(filePath);
    const sym = go.enclosingSymbol;
    const enclosingSymbol =
      sym && typeof sym === "object" && typeof (sym as Record<string, unknown>).name === "string"
        ? {
            name: String((sym as Record<string, unknown>).name),
            kind: String((sym as Record<string, unknown>).kind ?? ""),
          }
        : undefined;
    files.push({
      path: filePath,
      fileName,
      directory,
      matchCount: binary ? 0 : n || 1,
      ...(enclosingSymbol ? { enclosingSymbol } : {}),
      ...(binary ? { binary: true } : {}),
    });
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

/** Numeric first line of a read_file range (for jump-to-line on open). */
function readStartLineFromArgs(args: unknown): number | undefined {
  if (!args || typeof args !== "object") return undefined;
  const o = args as Record<string, unknown>;
  if (typeof o.offset === "number") return o.offset;
  if (typeof o.start_line === "number") return o.start_line;
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
    const rawSnippet =
      typeof o.content === "string"
        ? o.content
        : typeof o.snippet === "string"
          ? o.snippet
          : undefined;
    const snippet =
      rawSnippet != null ? stripUntrustedDataEnvelope(rawSnippet) : undefined;
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

/**
 * The "no results" card. Only for a payload that really IS a search result — an
 * explicit empty `sources` array — so a malformed or unrecognised envelope still
 * falls through to the generic handling rather than being mislabelled as an empty
 * search.
 */
function buildEmptyWebSearchView(
  payload: Record<string, unknown>,
  args?: unknown,
): Extract<ToolExpandView, { kind: "text" }> | null {
  if (!Array.isArray(payload.sources) || payload.sources.length > 0) return null;
  let query = "";
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    if (typeof a.query === "string") query = a.query.trim();
  }
  return {
    kind: "text",
    body: query ? `No results for "${query}"` : "No results",
  };
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
  const displayOutput = stripUntrustedDataEnvelope(output);
  if (!displayOutput.trim()) return null;
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
    body: displayOutput.trim(),
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

  // v13.8.1: the diff content is sourced from the model's own tool-call ARGS
  // (which already hold it — it's in the transcript exactly once), NOT echoed in
  // the result. So a completed/persisted write card renders an accurate diff with
  // ZERO extra tokens. Falls back to the result payload for older sessions.
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const argNew =
    typeof a.content === "string"
      ? a.content
      : typeof a.new_content === "string"
        ? a.new_content
        : undefined;
  const argOld = typeof a.old_content === "string" ? a.old_content : undefined;

  /**
   * `edit_file` also takes a MULTI-edit array — `edits: [{old_content, new_content}]`
   * (see the tool's schema in lib/tools/edit.ts). Nothing here used to read it, so
   * an edit sent that way arrived with both contents empty, which then made the
   * operation heuristic below guess "create" and render an existing file as a new,
   * one-line one. Observed 2026-08-29 on a 16-line edit to an existing Go file.
   *
   * Joining the spans is an approximation for N>1 — exact for the common single
   * edit, and for several it still shows the real before/after text instead of
   * nothing. The authoritative line COUNTS come from the payload either way.
   */
  const argEdits = Array.isArray(a.edits)
    ? (a.edits as unknown[]).filter(
        (e): e is { old_content?: unknown; new_content?: unknown } =>
          !!e && typeof e === "object",
      )
    : [];
  const joinEdits = (key: "old_content" | "new_content"): string | undefined => {
    if (argEdits.length === 0) return undefined;
    const parts = argEdits
      .map((e) => (typeof e[key] === "string" ? (e[key] as string) : ""))
      .filter((v) => v.length > 0);
    return parts.length > 0 ? parts.join("\n") : undefined;
  };

  const oldContent =
    argOld ??
    joinEdits("old_content") ??
    (typeof payload.oldContent === "string"
      ? payload.oldContent
      : typeof payload.old_content === "string"
        ? payload.old_content
        : "");
  const newContent =
    argNew ??
    joinEdits("new_content") ??
    (typeof payload.newContent === "string"
      ? payload.newContent
      : typeof payload.new_content === "string"
        ? payload.new_content
        : typeof payload.content === "string"
          ? payload.content
          : plainText?.trim() && !plainText.trim().startsWith("{")
            ? plainText
            : "");

  // Hunks main already computed, threaded through the tool args by
  // mergeWritePreviewIntoThread.
  const precomputedHunks = Array.isArray(a.precomputed_hunks)
    ? (a.precomputed_hunks as DiffHunk[])
    : undefined;

  /**
   * What the card SAYS happened.
   *
   * `edit_file`'s own enum is `write | replace | merge` (lib/tools/edit.ts), and
   * none of those matched here — so the tool's own answer was discarded on every
   * edit and the operation was guessed from whether `oldContent` happened to be
   * non-empty. When it wasn't, an ordinary edit to a long-existing file rendered
   * as **Create · (new file)**. That is the worst direction for this label to be
   * wrong in: a create is the thing you skim past.
   *
   * `replace` and `merge` both REQUIRE an existing file, so they are always an
   * update. Only `write` is genuinely ambiguous — it creates or fully overwrites —
   * so it alone still consults the content.
   */
  const operationRaw = payload.operation ?? payload.type ?? a.operation;
  const operation: "create" | "update" | "delete" =
    operationRaw === "create" || operationRaw === "delete"
      ? operationRaw
      : operationRaw === "replace" ||
          operationRaw === "merge" ||
          operationRaw === "update"
        ? "update"
        : oldContent
          ? "update"
          : "create";

  // Prefer the precise line counts the backend sent (cheap numbers), falling
  // back to a line-delta estimate from whatever content we have.
  const payloadAdded = typeof payload.added === "number" ? payload.added : undefined;
  const payloadRemoved = typeof payload.removed === "number" ? payload.removed : undefined;

  if (path && (oldContent || newContent || payloadAdded != null || payloadRemoved != null)) {
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
      addedCount:
        payloadAdded ?? Math.max(0, newLines - (operation === "create" ? 0 : oldLines)),
      removedCount:
        payloadRemoved ?? (operation === "delete" ? oldLines : Math.max(0, oldLines - newLines)),
      ...(precomputedHunks ? { precomputedHunks } : {}),
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
  const content = stripUntrustedDataEnvelope(
    plainText ?? (typeof payload.result === "string" ? payload.result : ""),
  );
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
    startLine: readStartLineFromArgs(args),
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
    body = prettyMaybeJson(stripUntrustedDataEnvelope(rawResult));
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

  // run_command renders as a command card (command + output + exit) even on
  // failure, so the user sees WHAT ran and its output — not just an error line.
  if (RUN_COMMAND_TOOLS.has(toolName)) {
    const cmd = buildCommandOutputView(envelope.payload, envelope.plainText);
    if (cmd) return cmd;
  }

  // Before the generic error return, for the same reason run_command is: a failed
  // delegation should still show the sub-agent's own report rather than "Tool failed".
  if (DELEGATION_TOOLS.has(toolName)) {
    const delegation = buildDelegationView(envelope.payload, envelope.plainText);
    if (delegation) return delegation;
  }

  /**
   * A `success: false` that is NOT a failure — a no-op, or a call the loop guard
   * declined. Shown as ordinary text, ABOVE the error branch, because the whole
   * point is that it must not be red. See `envelopeFromObject`: the markers are
   * explicit (`status: "noop"`, `loop_guidance`), never inferred.
   *
   * Observed before this existed: "Context compacted ✓" with a red "Tool
   * failed" underneath it, for a compaction that had correctly decided there was
   * nothing to compact and said so in its own words.
   */
  if (envelope.notice && streamStatus !== "error") {
    return { kind: "text", body: envelope.notice };
  }

  if (streamStatus === "error" || envelope.error) {
    // `envelope.error` already walked every field a tool uses to explain itself
    // (EXPLANATION_FIELDS), so reaching the literal fallback means the result
    // genuinely carried no explanation at all.
    const msg = envelope.error ?? "Tool failed";
    return { kind: "text", body: msg, isError: true };
  }

  const payload = envelope.payload;
  const plain = envelope.plainText;

  if (AGENT_LOG_TOOLS.has(toolName)) {
    const log = buildCommandOutputView(payload, plain);
    if (log) return log;
  }

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
    // A search that found nothing is a RESULT, and the card should say which query
    // came up empty. Falling through here reached the generic tail and printed a bare
    // "Done" — the least informative thing a finished search could possibly say, and
    // indistinguishable from a card that simply failed to render.
    const empty = buildEmptyWebSearchView(payload, args);
    if (empty) return empty;
  }

  /**
   * `tool_help` — the fetch half of progressive tool reveal.
   *
   * It had NO branch, so every call rendered as a bare **"Done"**: the card
   * showed nothing about which tool was asked about or what came back. That is
   * the same defect the `plan` and `task` comments above describe, and it is
   * worse here, because this tool exists precisely so a peripheral tool's full
   * instructions can be READ — and the read was the one thing the UI hid.
   *
   * Its result is `{ tool, usage }`, so the tool name is the header and the
   * usage text is the body. Markdown, because tool descriptions are written in it.
   */
  if (toolName === "tool_help") {
    const tool = typeof payload.tool === "string" ? payload.tool : "";
    const usage = typeof payload.usage === "string" ? payload.usage.trim() : "";
    if (usage) {
      return {
        kind: "text",
        body: tool ? `**${tool}**\n\n${usage}` : usage,
      };
    }
  }

  if (PLAN_TOOLS.has(toolName)) {
    const plan = buildPlanView(payload);
    if (plan) return plan;
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
    const hasImage = typeof payload.data === "string" && payload.data.length > 0;
    const dataUrl = hasImage
      ? `data:${typeof payload.mimeType === "string" ? payload.mimeType : "image/png"};base64,${payload.data}`
      : undefined;
    // When the result carries a session record, show the action timeline (with
    // the screenshot, if any) instead of a bare image.
    const rawSteps = Array.isArray(payload.sessionSteps) ? payload.sessionSteps : null;
    if (rawSteps && rawSteps.length > 0) {
      const steps = rawSteps
        .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
        .map((s) => ({
          type: typeof s.type === "string" ? s.type : "",
          detail: typeof s.detail === "string" ? s.detail : "",
          url: typeof s.url === "string" ? s.url : undefined,
        }))
        .slice(0, 200);
      return {
        kind: "browser_recording",
        steps,
        url: typeof payload.url === "string" ? payload.url : undefined,
        title: typeof payload.title === "string" ? payload.title : undefined,
        dataUrl,
      };
    }
    if (hasImage) {
      return {
        kind: "browser_screenshot",
        url: typeof payload.url === "string" ? payload.url : "",
        title: typeof payload.title === "string" ? payload.title : "",
        dataUrl: dataUrl!,
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
        ? stripUntrustedDataEnvelope(payload.content)
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
        body: stripUntrustedDataEnvelope(payload.result),
      };
    }
  }

  // Same class bug as the preview fallback: a `startsWith("{")` test passes any
  // mid-object FRAGMENT, which then gets sliced again for display. `looksLikeRawJson`
  // catches the fragment as well as the whole object.
  const preview = formatToolResultPreview(toolName, resultText, streamStatus);
  if (preview && !looksLikeRawJson(preview)) {
    return { kind: "text", body: preview };
  }

  const short =
    typeof payload.message === "string"
      ? payload.message
      : plain && !looksLikeRawJson(plain)
        ? plain.slice(0, 2000)
        : undefined;
  if (short?.trim()) {
    return { kind: "text", body: stripUntrustedDataEnvelope(short).trim() };
  }

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
