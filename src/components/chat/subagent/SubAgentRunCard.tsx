import { useEffect, useMemo, useRef } from "react";
import { useState } from "react";
import { Loader2, CheckCircle2, XCircle, Maximize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { SubAgentRunEntry, StreamThreadItem } from "@/lib/chat/stream-thread";
import {
  resolveSubagentCardLabel,
  compareThreadItems,
} from "@/lib/chat/stream-thread";
import { subagentPhaseLabel } from "@/lib/chat/subagent-phase-label";
import { InlineThoughtBlock } from "../InlineThoughtBlock";
import { StreamToolCallCard } from "../StreamToolCallCard";
import {
  streamCardScrollBody,
  streamToolCardButtonMultiLine,
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

// Order nested items exactly like the main chat: by (ts, seq), so thoughts and
// tool calls interleave in true insertion order instead of being grouped.
function sortNestedByTime(items: StreamThreadItem[]): StreamThreadItem[] {
  return [...items].sort(compareThreadItems);
}

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

/** Compact token figure run-subagent appends to the summary (`— 12.3k tokens`). */
function subagentTokensLabel(summary: string | undefined): string | null {
  const m = summary?.match(/—\s*([\d.]+[kKmM]?)\s+tokens\b/);
  return m ? `${m[1]} tok` : null;
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
  autoScroll = false,
}: {
  items: StreamThreadItem[];
  isStreaming: boolean;
  agentStatus: SubAgentRunEntry["status"];
  isHistorical?: boolean;
  autoScroll?: boolean;
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
    if (!autoScroll || !isStreaming || agentStatus !== "running") return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [flat.length, isStreaming, agentStatus, autoScroll]);

  return (
    <div
      ref={scrollRef}
      className={cn(streamCardScrollBody, "mt-2 space-y-1.5 border-t border-border/40 pt-2")}
    >
      {flat.map((item) => {
        if (item.kind === "thought") {
          const isProgress = item.id.startsWith("sub-progress-");
          const isNarration = item.id.startsWith("sub-text-");
          const isLive =
            isStreaming &&
            agentStatus === "running" &&
            item === flat[flat.length - 1];
          return (
            <InlineThoughtBlock
              key={`thought-${item.id}`}
              content={item.content}
              isStreaming={isLive}
              keepOpenAfterStream
              // Progress lines are tool status; sub-text- is live narration;
              // everything else is model reasoning.
              title={
                isProgress ? "Activity" : isNarration ? "Update" : "Thoughts"
              }
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
  isStreaming,
  isHistorical = false,
}: {
  agent: SubAgentRunEntry;
  isStreaming: boolean;
  isHistorical?: boolean;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
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

  const openDialog = () => setDialogOpen(true);
  const tokensLabel = subagentTokensLabel(agent.summary);

  return (
    <div className={cn(streamToolCardShell, "rounded-lg border overflow-hidden")}>
      <button
        type="button"
        className={cn(streamToolCardButtonMultiLine, "cursor-pointer")}
        onClick={openDialog}
      >
        <span className="w-3.5 shrink-0" aria-hidden />
        <StatusIcon />
        <span className="flex flex-1 flex-col items-start gap-0.5 min-w-0 text-left">
          <span className="text-xs font-medium text-foreground line-clamp-2 leading-snug w-full">
            {title}
          </span>
          <span className="text-[11px] font-normal leading-snug text-muted-foreground line-clamp-2 w-full">
            {subtitle}
          </span>
        </span>
        {tokensLabel ? (
          <span className="text-[10px] tabular-nums text-muted-foreground/70 shrink-0 mr-1 self-center">
            {tokensLabel}
          </span>
        ) : null}
        <Maximize2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </button>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-sm">{title}</DialogTitle>
          </DialogHeader>
          <div className="overflow-y-auto flex-1 min-h-0 pr-1">
            <NestedThreadItems
              items={agent.nestedItems}
              isStreaming={isStreaming}
              agentStatus={agent.status}
              isHistorical={isHistorical}
              autoScroll
            />
            {agent.summary?.trim() ? (
              <p className="mt-3 text-xs text-muted-foreground whitespace-pre-wrap border-t border-border/40 pt-3">
                {agent.summary.trim()}
              </p>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
