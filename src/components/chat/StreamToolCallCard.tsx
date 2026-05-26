import { useState } from "react";
import { ChevronDown, ChevronRight, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { InlineTimelineToolStatus } from "@/lib/chat/inline-timeline";

export function StreamToolCallCard({
  summary,
  detail,
  status,
  defaultCollapsed = true,
}: {
  summary: string;
  status: InlineTimelineToolStatus;
  detail?: string;
  defaultCollapsed?: boolean;
}) {
  const [open, setOpen] = useState(!defaultCollapsed);

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
        onClick={() => detail && setOpen((o) => !o)}
        className={cn(
          "w-full flex items-center gap-2 px-2.5 py-1.5 text-left",
          detail && "hover:bg-muted/40 cursor-pointer",
          !detail && "cursor-default",
        )}
      >
        {detail ? (
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
      {open && detail?.trim() ? (
        <pre className="max-h-40 overflow-auto border-t border-border/30 px-2.5 py-2 text-[10px] text-muted-foreground whitespace-pre-wrap break-words font-mono">
          {detail.trim()}
        </pre>
      ) : null}
    </div>
  );
}
