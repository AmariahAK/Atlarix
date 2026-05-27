import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SubAgentRunEntry, StreamThreadItem } from "@/lib/chat/stream-thread";
import { subagentPhaseLabel } from "@/lib/chat/subagent-phase-label";
import { InlineThoughtBlock } from "../InlineThoughtBlock";
import { StreamToolCallCard } from "../StreamToolCallCard";
import {
  streamToolCardButton,
  streamToolCardChevron,
  streamToolCardShell,
  streamToolCardSummary,
} from "../stream-item-styles";

function flattenNestedItems(items: StreamThreadItem[]): StreamThreadItem[] {
  const out: StreamThreadItem[] = [];
  for (const item of items) {
    if (item.kind === "tool_group") {
      out.push(...item.tools);
      continue;
    }
    out.push(item);
  }
  return out;
}

function sortNestedByTime(items: StreamThreadItem[]): StreamThreadItem[] {
  return [...items].sort((a, b) => a.ts - b.ts);
}

/** Latest tool or progress line for collapsed subtitle (by timestamp). */
function latestNestedActivitySummary(
  items: StreamThreadItem[],
  fallbackSummary?: string,
): string | null {
  const flat = flattenNestedItems(sortNestedByTime(items));
  let best: { ts: number; text: string } | null = null;
  for (const item of flat) {
    if (item.kind === "tool" && item.summary.trim()) {
      const text = item.summary.trim();
      if (!best || item.ts >= best.ts) best = { ts: item.ts, text };
    }
    if (item.kind === "thought" && item.content.trim()) {
      const text = item.content.trim();
      if (!best || item.ts >= best.ts) best = { ts: item.ts, text };
    }
  }
  if (best) return best.text;
  return firstLineSummary(fallbackSummary);
}

function firstLineSummary(summary: string | undefined): string | null {
  const line = summary?.trim().split(/\r?\n/)[0]?.trim();
  if (!line) return null;
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

const GENERIC_PHASE_LINES = new Set([
  "Exploring…",
  "Explore complete",
  "Researching…",
  "Research complete",
  "Reviewing…",
  "Review complete",
  "Working…",
  "Done",
  "Failed",
]);

function isGenericPhaseLine(line: string, phase: string): boolean {
  const t = line.trim();
  return t === phase.trim() || GENERIC_PHASE_LINES.has(t);
}

function NestedThreadItems({
  items,
  isStreaming,
  agentStatus,
}: {
  items: StreamThreadItem[];
  isStreaming: boolean;
  agentStatus: SubAgentRunEntry["status"];
}) {
  const flat = flattenNestedItems(sortNestedByTime(items));
  if (flat.length === 0) {
    return (
      <p className="mt-2 text-[10px] text-muted-foreground italic border-t border-border/40 pt-2">
        {agentStatus === "running"
          ? "Waiting for tools…"
          : "No tool activity recorded for this run."}
      </p>
    );
  }
  return (
    <div className="mt-2 space-y-1 border-t border-border/40 pt-2">
      {flat.map((item) => {
        if (item.kind === "thought") {
          const isLiveProgress =
            isStreaming &&
            agentStatus === "running" &&
            item.id.startsWith("sub-progress-") &&
            item === flat[flat.length - 1];
          return (
            <InlineThoughtBlock
              key={`thought-${item.id}-${item.ts}`}
              content={item.content}
              isStreaming={isLiveProgress}
              keepOpenAfterStream
            />
          );
        }
        if (item.kind === "tool") {
          return (
            <StreamToolCallCard
              key={`${item.id}-${item.ts}`}
              summary={item.summary}
              expand={item.expand}
              detail={item.detail}
              status={item.status}
              toolName={item.toolName}
            />
          );
        }
        return null;
      })}
    </div>
  );
}

export function SubAgentRunCard({
  agent,
  defaultExpanded = true,
  isStreaming,
}: {
  agent: SubAgentRunEntry;
  defaultExpanded?: boolean;
  isStreaming: boolean;
}) {
  const [open, setOpen] = useState(defaultExpanded);
  const phase = subagentPhaseLabel(agent.agentType, agent.status);
  const title = agent.label || agent.scope || agent.agentType;
  const latestActivity = useMemo(
    () => latestNestedActivitySummary(agent.nestedItems, agent.summary),
    [agent.nestedItems, agent.summary],
  );
  const subtitle =
    latestActivity && !isGenericPhaseLine(latestActivity, phase)
      ? latestActivity
      : phase;

  const StatusIcon =
    agent.status === "running"
      ? () => <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-600 dark:text-amber-500" />
      : agent.status === "error"
        ? () => <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
        : () => (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-500" />
          );

  const preview =
    agent.summary?.trim().split(/\r?\n/)[0]?.slice(0, 160) ?? "";

  return (
    <div className={cn(streamToolCardShell, "rounded-lg border px-2 py-1")}>
      <button
        type="button"
        className={cn(streamToolCardButton, "py-1")}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? (
          <ChevronDown className={streamToolCardChevron} />
        ) : (
          <ChevronRight className={streamToolCardChevron} />
        )}
        <StatusIcon />
        <span className={cn(streamToolCardSummary, "flex flex-col items-start gap-0.5 min-w-0")}>
          <span className="truncate max-w-full">{title}</span>
          <span className="text-[10px] font-normal text-muted-foreground truncate max-w-full">
            {subtitle}
          </span>
        </span>
      </button>
      {open ? (
        <div className="px-2 pb-2">
          <NestedThreadItems
            items={agent.nestedItems}
            isStreaming={isStreaming}
            agentStatus={agent.status}
          />
          {agent.status !== "running" && preview && agent.nestedItems.length === 0 ? (
            <p className="mt-2 text-[10px] text-muted-foreground line-clamp-3 border-t border-border/40 pt-2">
              {preview}
            </p>
          ) : null}
        </div>
      ) : latestActivity && latestActivity !== phase ? (
        <p className="px-2 pb-1.5 text-[10px] text-muted-foreground line-clamp-1">
          {latestActivity}
        </p>
      ) : null}
    </div>
  );
}
