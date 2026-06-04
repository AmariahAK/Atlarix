import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { InlineTimelineToolStatus } from "@/lib/chat/inline-timeline";
import {
  isToolExpandable,
  type ToolExpandView,
} from "@/lib/chat/tool-expand-view";
import { ToolStatusIcon } from "./ToolStatusIcon";
import { TextShimmer } from "./TextShimmer";
import { ToolExpandPanel } from "./tool-expand/ToolExpandPanel";
import {
  streamToolCardButton,
  streamToolCardChevron,
  streamToolCardShell,
  streamToolCardSummary,
} from "./stream-item-styles";

/** "(3.2s)" elapsed suffix — hidden for sub-100ms blips. */
function formatElapsed(ms: number | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 100) return null;
  if (ms < 60_000) return `(${(ms / 1000).toFixed(1)}s)`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `(${mins}m ${secs}s)`;
}

export function StreamToolCallCard({
  summary,
  expand,
  detail,
  status,
  toolName: _toolName,
  elapsedMs,
}: {
  summary: string;
  status: InlineTimelineToolStatus;
  expand?: ToolExpandView;
  /** @deprecated legacy plain-text expand; use expand */
  detail?: string;
  toolName?: string;
  defaultCollapsed?: boolean;
  /** Wall-clock duration once the tool finished (v10 cost visibility). */
  elapsedMs?: number;
}) {
  const isRunning = status === "running";
  const isError = status === "error";
  const resolvedExpand: ToolExpandView =
    expand ??
    (detail?.trim()
      ? { kind: "text", body: detail.trim(), isError }
      : { kind: "none" });
  const expandable = !isRunning && isToolExpandable(resolvedExpand);
  // Failed tools open their error detail by default — no extra click to see why.
  const [open, setOpen] = useState(isError);

  return (
    <div className={cn(streamToolCardShell, "overflow-hidden")}>
      <button
        type="button"
        onClick={() => expandable && setOpen((o) => !o)}
        className={cn(
          streamToolCardButton,
          expandable && "cursor-pointer",
          !expandable && "cursor-default hover:bg-transparent dark:hover:bg-transparent",
        )}
        aria-expanded={expandable ? open : undefined}
      >
        {expandable ? (
          open ? (
            <ChevronDown className={streamToolCardChevron} />
          ) : (
            <ChevronRight className={streamToolCardChevron} />
          )
        ) : (
          <span className="w-3.5 shrink-0" aria-hidden />
        )}
        <ToolStatusIcon status={status} />
        <span className={streamToolCardSummary}>
          {isRunning ? <TextShimmer>{summary}</TextShimmer> : summary}
        </span>
        {!isRunning && formatElapsed(elapsedMs) ? (
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
            {formatElapsed(elapsedMs)}
          </span>
        ) : null}
        {resolvedExpand.kind === "diff" ? (
          <span className="shrink-0 flex items-center gap-1 text-[10px] font-medium tabular-nums">
            {resolvedExpand.addedCount != null && resolvedExpand.addedCount > 0 ? (
              <span className="text-emerald-600 dark:text-emerald-500">
                +{resolvedExpand.addedCount}
              </span>
            ) : null}
            {resolvedExpand.removedCount != null && resolvedExpand.removedCount > 0 ? (
              <span className="text-red-600 dark:text-red-400">
                -{resolvedExpand.removedCount}
              </span>
            ) : null}
          </span>
        ) : null}
      </button>
      {expandable && open ? <ToolExpandPanel view={resolvedExpand} /> : null}
    </div>
  );
}
