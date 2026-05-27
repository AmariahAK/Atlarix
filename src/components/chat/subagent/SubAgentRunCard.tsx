import { useState } from "react";
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

function NestedThreadItems({
  items,
  isStreaming,
}: {
  items: StreamThreadItem[];
  isStreaming: boolean;
}) {
  const flat = flattenNestedItems(items);
  if (flat.length === 0) return null;
  return (
    <div className="mt-2 space-y-1 border-t border-border/40 pt-2">
      {flat.map((item) => {
        if (item.kind === "thought") {
          return (
            <InlineThoughtBlock
              key={`thought-${item.id}`}
              content={item.content}
              isStreaming={isStreaming && item.id.includes("live")}
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
          <span className="text-[10px] font-normal text-muted-foreground">{phase}</span>
        </span>
      </button>
      {open ? (
        <div className="px-2 pb-2">
          <NestedThreadItems
            items={agent.nestedItems}
            isStreaming={isStreaming}
          />
          {agent.status === "running" && agent.nestedItems.length === 0 ? (
            <p className="mt-2 text-[10px] text-muted-foreground italic">
              {phase}
            </p>
          ) : null}
          {agent.summary ? (
            <pre className="mt-2 max-h-40 overflow-auto text-[10px] whitespace-pre-wrap break-words text-muted-foreground rounded-md bg-muted/40 p-2">
              {preview}
              {agent.summary.length > preview.length ? "…" : ""}
            </pre>
          ) : null}
        </div>
      ) : !open && preview ? (
        <p className="px-2 pb-1.5 text-[10px] text-muted-foreground line-clamp-1">{preview}</p>
      ) : null}
    </div>
  );
}
