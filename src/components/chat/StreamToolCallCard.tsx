import { useState } from "react";
import { ChevronDown, ChevronRight, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { InlineTimelineToolStatus } from "@/lib/chat/inline-timeline";
import {
  isToolExpandable,
  type ToolExpandView,
} from "@/lib/chat/tool-expand-view";
import { ToolExpandPanel } from "./tool-expand/ToolExpandPanel";
import {
  streamToolCardButton,
  streamToolCardChevron,
  streamToolCardShell,
  streamToolCardSummary,
} from "./stream-item-styles";

export function StreamToolCallCard({
  summary,
  expand,
  detail,
  status,
  toolName: _toolName,
}: {
  summary: string;
  status: InlineTimelineToolStatus;
  expand?: ToolExpandView;
  /** @deprecated legacy plain-text expand; use expand */
  detail?: string;
  toolName?: string;
  defaultCollapsed?: boolean;
}) {
  const isRunning = status === "running";
  const isError = status === "error";
  const resolvedExpand: ToolExpandView =
    expand ??
    (detail?.trim()
      ? { kind: "text", body: detail.trim(), isError }
      : { kind: "none" });
  const expandable = !isRunning && isToolExpandable(resolvedExpand);
  const [open, setOpen] = useState(false);

  const StatusIcon = isRunning
    ? () => <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-600 dark:text-amber-500" />
    : isError
      ? () => <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
      : () => (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-500" />
        );

  return (
    <div className={streamToolCardShell}>
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
        <StatusIcon />
        <span className={streamToolCardSummary}>{summary}</span>
      </button>
      {expandable && open ? <ToolExpandPanel view={resolvedExpand} /> : null}
    </div>
  );
}
