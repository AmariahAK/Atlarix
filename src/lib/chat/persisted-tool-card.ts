import type { AssistantMessagePart } from "@/lib/chat/assistant-message-parts";
import type { InlineTimelineToolStatus } from "@/lib/chat/inline-timeline";
import {
  formatToolResultPreview,
  getToolCompletedSummary,
  noopSummary,
  backgroundStartedSummary,
  getToolFailedSummary,
  getToolRunningSummary,
} from "@/lib/chat/stream-tool-display";
import {
  buildToolExpandView,
  type ToolExpandView,
} from "@/lib/chat/tool-expand-view";

function argsPathHint(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const o = args as Record<string, unknown>;
  for (const key of ["path", "file_path", "query", "command", "pattern"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/** Human-readable one-line label for a saved tool part (never raw JSON). */

type ToolPart = Extract<AssistantMessagePart, { type: "tool" }>;

/**
 * A stored no-op (compress_context's status:"noop") is tagged status="error",
 * because the result says success:false. It did what it should: drawn as done,
 * not a red "Failed: … / Tool failed" (QA #16, stored and reloaded steps).
 */
function settledPart(part: ToolPart): ToolPart {
  return part.status === "error" && noopSummary(part.toolName, part.resultText)
    ? { ...part, status: "success" }
    : part;
}

export function getPersistedToolSummary(
  rawPart: Extract<AssistantMessagePart, { type: "tool" }>,
): string {
  const part = settledPart(rawPart);
  const toolArgs =
    part.args && typeof part.args === "object"
      ? (part.args as Record<string, unknown>)
      : undefined;
  if (part.status === "running") {
    return getToolRunningSummary(part.toolName, toolArgs);
  }
  if (part.status === "error") {
    // Was `getToolCompletedSummary` — past-tense SUCCESS prose ("Found files matching
    // …") with the error appended after a colon, so a reloaded failed card claimed the
    // thing it had failed to do. Name the attempt, then the error.
    const err = part.error?.trim();
    const base = getToolFailedSummary(part.toolName, toolArgs);
    return err ? `${base}: ${err.slice(0, 80)}` : base;
  }
  const hint = argsPathHint(part.args);
  const base =
    noopSummary(part.toolName, part.resultText) ??
    backgroundStartedSummary(part.toolName, part.resultText) ??
    getToolCompletedSummary(part.toolName, toolArgs);
  if (hint) {
    const short = hint.length > 56 ? `${hint.slice(0, 55)}…` : hint;
    return `${base} · ${short}`;
  }
  // For result-count tools (MCP / web), surface a concise count from the result
  // text so reloaded cards match the live summary (e.g. "3 MCP servers · 12 tools").
  if (COUNT_SUMMARY_TOOLS.has(part.toolName) && part.resultText?.trim()) {
    const preview = formatToolResultPreview(
      part.toolName,
      part.resultText,
      "done",
    );
    if (preview && preview !== "Done" && !preview.includes("\n")) {
      const short = preview.length > 64 ? `${preview.slice(0, 63)}…` : preview;
      return `${base} · ${short}`;
    }
  }
  return base;
}

const COUNT_SUMMARY_TOOLS = new Set([
  "list_available_mcps",
  "mcp_call",
  "web_search",
  "deep_research",
]);

/** Structured expand panel for persisted tool parts (never raw JSON). */
export function getPersistedToolExpandView(
  rawPart: Extract<AssistantMessagePart, { type: "tool" }>,
): ToolExpandView {
  const part = settledPart(rawPart);
  if (part.status === "running") return { kind: "none" };

  const status = part.status === "error" ? "error" : ("done" as const);

  if (!part.resultText?.trim() && part.error?.trim()) {
    return { kind: "text", body: part.error.trim(), isError: true };
  }

  return buildToolExpandView(part.toolName, part.args, part.resultText, status);
}

export function persistedToolPartToStreamCard(
  rawPart: Extract<AssistantMessagePart, { type: "tool" }>,
): {
  summary: string;
  expand: ToolExpandView;
  status: InlineTimelineToolStatus;
  toolName: string;
} {
  const part = settledPart(rawPart);
  const status: InlineTimelineToolStatus =
    part.status === "running"
      ? "running"
      : part.status === "error"
        ? "error"
        : "done";

  return {
    summary: getPersistedToolSummary(part),
    expand: getPersistedToolExpandView(part),
    status,
    toolName: part.toolName,
  };
}
