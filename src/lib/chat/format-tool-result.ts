import { summarizeInlineTool } from "@/lib/chat/inline-tool-summary";
import type { AssistantMessagePart } from "@/lib/chat/assistant-message-parts";
import { collapseToolOutput } from "@/lib/chat/collapse-tool-output";

export type ToolResultBodyKind =
  | "markdown"
  | "text"
  | "json"
  | "none"
  | "repo_overview";

export type FormattedToolResult = {
  summary: string;
  body: string;
  bodyKind: ToolResultBodyKind;
};

const REPO_TOOLS = new Set([
  "get_repo_overview",
  "explore_folder",
  "list_files",
]);
const REPO_OVERVIEW_TOOLS = new Set(["get_repo_overview"]);
const SEARCH_TOOLS = new Set([
  "search_code",
  "search",
  "grep",
  "web_search",
]);
const READ_TOOLS = new Set(["read_file", "read_url"]);

function tryParseJson(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return undefined;
  }
}

function unwrapToolPayload(raw: string | undefined): {
  inner: string;
  success?: boolean;
  error?: string;
} {
  if (!raw?.trim()) return { inner: "" };
  const parsed = tryParseJson(raw.trim());
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const o = parsed as Record<string, unknown>;
    if (typeof o.error === "string") {
      return { inner: o.error, success: false, error: o.error };
    }
    if (o.success === false && typeof o.message === "string") {
      return { inner: o.message, success: false, error: o.message };
    }
    if ("result" in o) {
      const r = o.result;
      if (typeof r === "string") return { inner: r, success: o.success !== false };
      if (r && typeof r === "object") {
        const nested = r as Record<string, unknown>;
        if (typeof nested.result === "string") {
          return { inner: nested.result, success: nested.success !== false };
        }
        if (typeof nested.error === "string") {
          return { inner: nested.error, success: false };
        }
        return { inner: JSON.stringify(r, null, 2), success: o.success !== false };
      }
    }
    if (typeof o.message === "string" && Object.keys(o).length <= 3) {
      return { inner: o.message, success: o.success !== false };
    }
  }
  return { inner: raw.trim() };
}

function looksLikeMarkdown(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (/^#\s/m.test(t)) return true;
  if (/^[-*]\s/m.test(t)) return true;
  if (t.includes("## ") || t.includes("\n- ")) return true;
  return false;
}

function oneLineSummary(text: string, max = 120): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  return `${line.slice(0, max - 1)}…`;
}

function summarizeRepoOverview(toolName: string, args: unknown, inner: string): string {
  const a = args as Record<string, unknown> | undefined;
  const focus =
    (typeof a?.focus_path === "string" && a.focus_path) ||
    (typeof a?.path === "string" && a.path) ||
    "";
  if (toolName === "get_repo_overview") {
    const title = inner.match(/^#\s+(.+)/m)?.[1];
    return title
      ? `Repo overview: ${title.replace(/^Repo overview:\s*/i, "").slice(0, 72)}`
      : focus
        ? `Repo overview: ${focus}`
        : "Repo overview";
  }
  return focus ? `Explored ${focus}` : "Explored files";
}

const MAX_BODY_CHARS = 12_000;
const PREVIEW_MAX_LINES = 48;
const PREVIEW_MAX_CHARS = 6_000;

function truncateBody(body: string): string {
  if (body.length <= MAX_BODY_CHARS) return body;
  return `${body.slice(0, MAX_BODY_CHARS)}\n\n… (truncated)`;
}

function previewBody(body: string): string {
  const { output, overflow } = collapseToolOutput(
    body,
    PREVIEW_MAX_LINES,
    PREVIEW_MAX_CHARS,
  );
  if (!overflow) return output;
  return output;
}

/** Format tool args + result for inline collapsed cards. */
export function formatToolResultDisplay(
  part: Extract<AssistantMessagePart, { type: "tool" }>,
): FormattedToolResult {
  const { toolName, args, resultText, status } = part;
  const baseSummary = summarizeInlineTool(part);
  const { inner, error } = unwrapToolPayload(resultText);

  if (status === "error" || error) {
    return {
      summary: baseSummary,
      body: error || inner || "Tool failed",
      bodyKind: "text",
    };
  }

  if (!inner && status === "running") {
    const argsStr =
      args != null && typeof args === "object"
        ? JSON.stringify(args, null, 2)
        : typeof args === "string"
          ? args
          : "";
    return {
      summary: baseSummary,
      body: argsStr,
      bodyKind: argsStr.startsWith("{") ? "json" : "text",
    };
  }

  if (!inner) {
    return { summary: baseSummary, body: "", bodyKind: "none" };
  }

  if (REPO_OVERVIEW_TOOLS.has(toolName) && looksLikeMarkdown(inner)) {
    return {
      summary: summarizeRepoOverview(toolName, args, inner),
      body: truncateBody(inner),
      bodyKind: "repo_overview",
    };
  }

  if (REPO_TOOLS.has(toolName)) {
    return {
      summary: summarizeRepoOverview(toolName, args, inner),
      body: previewBody(truncateBody(inner)),
      bodyKind: looksLikeMarkdown(inner) ? "markdown" : "text",
    };
  }

  if (READ_TOOLS.has(toolName)) {
    return {
      summary: baseSummary,
      body: previewBody(truncateBody(inner)),
      bodyKind: looksLikeMarkdown(inner) ? "markdown" : "text",
    };
  }

  if (SEARCH_TOOLS.has(toolName)) {
    return {
      summary: baseSummary,
      body: previewBody(truncateBody(oneLineSummary(inner, 2000))),
      bodyKind: "text",
    };
  }

  if (looksLikeMarkdown(inner)) {
    return {
      summary: oneLineSummary(inner.split("\n").find((l) => l.trim()) ?? baseSummary),
      body: previewBody(truncateBody(inner)),
      bodyKind: "markdown",
    };
  }

  if (inner.startsWith("{") || inner.startsWith("[")) {
    const pretty = tryParseJson(inner);
    if (pretty !== undefined) {
      return {
        summary: baseSummary,
        body: truncateBody(JSON.stringify(pretty, null, 2)),
        bodyKind: "json",
      };
    }
  }

  return {
    summary: baseSummary,
    body: previewBody(truncateBody(inner)),
    bodyKind: "text",
  };
}
