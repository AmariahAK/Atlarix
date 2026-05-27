import type { AssistantMessagePart } from "@/lib/chat/assistant-message-parts";
import type { InlineTimelineToolStatus } from "@/lib/chat/inline-timeline";
import {
  getToolCompletedSummary,
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
export function getPersistedToolSummary(
  part: Extract<AssistantMessagePart, { type: "tool" }>,
): string {
  if (part.status === "running") {
    return getToolRunningSummary(part.toolName);
  }
  if (part.status === "error") {
    const err = part.error?.trim();
    const base = getToolCompletedSummary(part.toolName);
    return err ? `${base}: ${err.slice(0, 80)}` : base;
  }
  const hint = argsPathHint(part.args);
  const base = getToolCompletedSummary(part.toolName);
  if (hint) {
    const short =
      hint.length > 56 ? `${hint.slice(0, 55)}…` : hint;
    return `${base} · ${short}`;
  }
  return base;
}

/** Structured expand panel for persisted tool parts (never raw JSON). */
export function getPersistedToolExpandView(
  part: Extract<AssistantMessagePart, { type: "tool" }>,
): ToolExpandView {
  if (part.status === "running") return { kind: "none" };

  const status =
    part.status === "error" ? "error" : ("done" as const);

  if (!part.resultText?.trim() && part.error?.trim()) {
    return { kind: "text", body: part.error.trim(), isError: true };
  }

  return buildToolExpandView(
    part.toolName,
    part.args,
    part.resultText,
    status,
  );
}

export function persistedToolPartToStreamCard(
  part: Extract<AssistantMessagePart, { type: "tool" }>,
): {
  summary: string;
  expand: ToolExpandView;
  status: InlineTimelineToolStatus;
  toolName: string;
} {
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
