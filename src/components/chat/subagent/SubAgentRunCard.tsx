import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SubAgentRunEntry, StreamThreadItem } from "@/lib/chat/stream-thread";
import { resolveSubagentCardLabel } from "@/lib/chat/stream-thread";
import { subagentPhaseLabel } from "@/lib/chat/subagent-phase-label";
import { InlineThoughtBlock } from "../InlineThoughtBlock";
import { StreamToolCallCard } from "../StreamToolCallCard";
import {
  streamCardScrollBody,
  streamToolCardButtonMultiLine,
  streamToolCardChevron,
  streamToolCardShell,
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
  isHistorical,
}: {
  items: StreamThreadItem[];
  isStreaming: boolean;
  agentStatus: SubAgentRunEntry["status"];
  isHistorical?: boolean;
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
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isStreaming || agentStatus !== "running") return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [flat.length, isStreaming, agentStatus]);

  return (
    <div
      ref={scrollRef}
      className={cn(streamCardScrollBody, "mt-2 space-y-1.5 border-t border-border/40 pt-2")}
    >
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
  isHistorical = false,
}: {
  agent: SubAgentRunEntry;
  defaultExpanded?: boolean;
  isStreaming: boolean;
  isHistorical?: boolean;
}) {
  const [open, setOpen] = useState(
    defaultExpanded || isHistorical || (isStreaming && agent.status === "running"),
  );
  const phase = subagentPhaseLabel(agent.agentType, agent.status);
  const title = resolveSubagentCardLabel(agent);
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
    <div className={cn(streamToolCardShell, "rounded-lg border overflow-hidden")}>
      <button
        type="button"
        className={streamToolCardButtonMultiLine}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? (
          <ChevronDown className={streamToolCardChevron} />
        ) : (
          <ChevronRight className={streamToolCardChevron} />
        )}
        <StatusIcon />
        <span className="flex flex-1 flex-col items-start gap-0.5 min-w-0 text-left">
          <span className="text-xs font-medium text-foreground line-clamp-2 leading-snug w-full">
            {title}
          </span>
          <span className="text-[11px] font-normal leading-snug text-muted-foreground line-clamp-2 w-full">
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
            isHistorical={isHistorical}
          />
          {agent.status !== "running" && preview && agent.nestedItems.length === 0 ? (
            <p className="mt-2 text-[10px] text-muted-foreground line-clamp-3 border-t border-border/40 pt-2">
              {preview}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
