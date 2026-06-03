import type { ActivityStreamItem } from "@/atoms/sourceAtoms";
import type { CompletedTurnThinkingSnapshot } from "@/lib/thinking/extract-thinking-from-content";
import { getToolActivityLabel } from "@/lib/tool-activity-labels";

export type InlineTimelineToolStatus = "running" | "done" | "error";

export type InlineTimelineItem =
  | { kind: "thought"; content: string; timestamp: number }
  | {
      kind: "tool";
      id: string;
      toolName: string;
      summary: string;
      detail?: string;
      status: InlineTimelineToolStatus;
      timestamp: number;
    };


export function summarizeToolActivityItem(item: ActivityStreamItem): string {
  const name = (item.toolName ?? item.label ?? "tool").trim();
  const detail = item.detail?.trim() ?? "";
  const lower = `${name} ${detail}`.toLowerCase();

  if (name === "read_file" && detail) {
    const path = detail.split(/\s/)[0];
    const range = detail.match(/L(\d+)[–-](\d+)/i);
    if (range) return `Read ${path} L${range[1]}–${range[2]}`;
    return `Read ${detail.slice(0, 80)}`;
  }
  if (
    name === "search_code" ||
    name === "search" ||
    lower.includes("grep")
  ) {
    return detail ? `Grepped for ${detail.slice(0, 72)}` : "Ran codebase search";
  }
  if (name === "explore_folder" || name === "list_files") {
    return detail ? `Explored ${detail.slice(0, 72)}` : "Explored files";
  }
  if (name === "run_command" || name === "execute_command") {
    return detail ? `Ran \`${detail.slice(0, 60)}\`` : "Ran terminal command";
  }
  if (detail) {
    const base = getToolActivityLabel(name).replace(/…$/u, "");
    return `${base}: ${detail.slice(0, 80)}`;
  }
  return getToolActivityLabel(name).replace(/…$/u, "");
}

export function buildInlineTimelineFromActivity(
  items: ActivityStreamItem[],
  thinking?: CompletedTurnThinkingSnapshot | null,
): InlineTimelineItem[] {
  const sorted = [...items].sort(
    (a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0),
  );
  const out: InlineTimelineItem[] = [];

  const thoughtLines = [
    ...(thinking?.thoughts ?? []),
    thinking?.reasoningFromTags?.trim(),
    thinking?.modelReasoning?.trim(),
  ].filter((x): x is string => Boolean(x && String(x).trim()));

  if (thoughtLines.length > 0) {
    out.push({
      kind: "thought",
      content: thoughtLines.join("\n\n"),
      timestamp: sorted[0]?.timestamp ?? Date.now(),
    });
  }

  for (const it of sorted) {
    if (it.type !== "tool_use") continue;
    const status: InlineTimelineToolStatus =
      it.status === "error"
        ? "error"
        : it.status === "running"
          ? "running"
          : "done";
    out.push({
      kind: "tool",
      id: it.id,
      toolName: it.toolName ?? it.label ?? "tool",
      summary: summarizeToolActivityItem(it),
      detail: it.detail,
      status,
      timestamp: it.timestamp ?? Date.now(),
    });
  }

  // Counsel items are already handled inline via content tags; keep them out of the
  // legacy timeline builder so they do not duplicate sections.
  // (AssistantMessageBody renders counsel via completedTurnArtifacts instead.)

  return out;
}
