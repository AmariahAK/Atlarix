import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { InlineTimelineToolStatus } from "@/lib/chat/inline-timeline";

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
      ? () => <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-500" />
      : status === "error"
        ? () => <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
        : () => <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />;

  return (
    <div className="my-1.5 rounded-lg border border-border/40 bg-muted/20 overflow-hidden text-xs">
      <button
        type="button"
        onClick={() => hasBody && setOpen((o) => !o)}
        className={cn(
          "w-full flex items-center gap-2 px-2.5 py-1.5 text-left",
          hasBody && "hover:bg-muted/40 cursor-pointer",
          !hasBody && "cursor-default",
        )}
      >
        {hasBody ? (
          open ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <StatusIcon />
        <span className="flex-1 min-w-0 truncate text-foreground/90">{summary}</span>
      </button>
      {open && hasBody ? (
        <div
          className={cn(
            "border-t border-border/30 overflow-auto overscroll-contain px-2.5 py-2",
            maxBodyHeightClass,
          )}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
