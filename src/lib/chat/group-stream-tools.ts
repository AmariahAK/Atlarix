import type {
  StreamThreadItem,
  StreamThreadToolStatus,
} from "@/lib/chat/stream-thread";
import { isContextToolName } from "@/lib/chat/context-tools";

export type StreamToolItem = Extract<StreamThreadItem, { kind: "tool" }>;

const TERMINAL = new Set(["run_command", "stream_terminal_output"]);
const SEARCH = new Set(["search", "grep", "search_code"]);
const WEB = new Set(["web_search", "read_url"]);

const NON_GROUPABLE = new Set([
  "delegate_to_agent",
  "spawn_sub_agent",
  "task",
  "ask_user",
]);

function toolCategory(name: string): string | null {
  if (TERMINAL.has(name)) return "Terminal";
  if (SEARCH.has(name)) return "Search";
  if (WEB.has(name)) return "Web";
  if (isContextToolName(name)) return "Read / explore";
  return null;
}

function isGroupableTool(name: string): boolean {
  return !NON_GROUPABLE.has(name) && toolCategory(name) != null;
}

function groupStatus(tools: StreamToolItem[]): StreamThreadToolStatus {
  if (tools.some((t) => t.status === "running")) return "running";
  if (tools.some((t) => t.status === "error")) return "error";
  return "done";
}

function summarizeTools(tools: StreamToolItem[], category: string): string {
  const running = tools.filter((t) => t.status === "running").length;
  if (running > 0) {
    return `${category} · ${running} running, ${tools.length} total`;
  }
  const previews = tools
    .map((t) => t.summary.trim())
    .filter(Boolean)
    .slice(0, 2);
  const tail =
    previews.length > 0 ? ` — ${previews.join("; ").slice(0, 100)}` : "";
  return `${category} · ${tools.length} tool${tools.length === 1 ? "" : "s"}${tail}`;
}

function flushBatch(
  batch: StreamToolItem[],
  category: string,
  out: StreamThreadItem[],
): void {
  if (batch.length === 0) return;
  if (batch.length === 1) {
    out.push(batch[0]!);
    return;
  }
  out.push({
    kind: "tool_group",
    id: `tg-${category}-${batch[0]!.id}-${batch.length}`,
    category,
    tools: [...batch],
    summary: summarizeTools(batch, category),
    status: groupStatus(batch),
    ts: batch[batch.length - 1]!.ts,
  });
}

/** Coalesce consecutive groupable tools by category (main thread and sub-agent nested timelines). */
export function groupStreamThreadTools(
  items: StreamThreadItem[],
): StreamThreadItem[] {
  const out: StreamThreadItem[] = [];
  let batch: StreamToolItem[] = [];
  let batchCategory: string | null = null;

  const flush = () => {
    if (batchCategory) flushBatch(batch, batchCategory, out);
    batch = [];
    batchCategory = null;
  };

  for (const item of items) {
    if (item.kind === "subagent" && item.nestedItems) {
      flush();
      out.push({
        ...item,
        nestedItems: groupStreamThreadTools(item.nestedItems),
      });
      continue;
    }

    if (item.kind === "tool" && isGroupableTool(item.toolName)) {
      const cat = toolCategory(item.toolName)!;
      if (batchCategory && cat !== batchCategory) flush();
      batchCategory = cat;
      batch.push(item);
      continue;
    }

    flush();
    out.push(item);
  }

  flush();
  return out;
}

/** Expand legacy `tool_group` rows back into individual tool cards for display. */
export function flattenToolGroupsInThread(
  items: StreamThreadItem[],
): StreamThreadItem[] {
  const out: StreamThreadItem[] = [];
  for (const item of items) {
    if (item.kind === "tool_group") {
      out.push(...item.tools);
      continue;
    }
    if (item.kind === "subagent_round") {
      out.push({
        ...item,
        agents: item.agents.map((agent) => ({
          ...agent,
          nestedItems: flattenToolGroupsInThread(agent.nestedItems),
        })),
      });
      continue;
    }
    if (item.kind === "subagent" && item.nestedItems) {
      out.push({
        ...item,
        nestedItems: flattenToolGroupsInThread(item.nestedItems),
      });
      continue;
    }
    out.push(item);
  }
  return out;
}
