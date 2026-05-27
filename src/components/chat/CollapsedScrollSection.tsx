import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { InlineTimelineToolStatus } from "@/lib/chat/inline-timeline";
import {
  streamToolCardButton,
  streamToolCardChevron,
  streamToolCardShell,
  streamToolCardSummary,
} from "./stream-item-styles";

export function CollapsedScrollSection({
  summary,
  status,
  defaultCollapsed = true,
  children,
  maxBodyHeightClass = "max-h-48",
}: {
  summary: string;
  status: InlineTimelineToolStatus;
  defaultCollapsed?: boolean;
  children?: ReactNode;
  maxBodyHeightClass?: string;
}) {
  const [open, setOpen] = useState(!defaultCollapsed);
  const hasBody = children != null;

  const StatusIcon =
    status === "running"
      ? () => <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-600 dark:text-amber-500" />
      : status === "error"
        ? () => <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
        : () => (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-500" />
          );

  return (
    <div className={streamToolCardShell}>
      <button
        type="button"
        onClick={() => hasBody && setOpen((o) => !o)}
        className={cn(
          streamToolCardButton,
          hasBody && "cursor-pointer",
          !hasBody && "cursor-default hover:bg-transparent dark:hover:bg-transparent",
        )}
      >
        {hasBody ? (
          open ? (
            <ChevronDown className={streamToolCardChevron} />
          ) : (
            <ChevronRight className={streamToolCardChevron} />
          )
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <StatusIcon />
        <span className={streamToolCardSummary}>{summary}</span>
      </button>
      {open && hasBody ? (
        <div
          className={cn(
            "border-t border-border overflow-auto overscroll-contain px-2.5 py-2 text-foreground/85 dark:text-muted-foreground",
            maxBodyHeightClass,
          )}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
