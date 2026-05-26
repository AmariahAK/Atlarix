import { useState } from "react";
import { ChevronDown, ChevronRight, CheckCircle2, Loader2, XCircle, FileCode2 } from "lucide-react";
import type { ToolPartStatus } from "@/lib/chat/assistant-message-parts";

export function InlineFileChangeCard({
  toolName,
  summary,
  status,
  args,
  resultText,
  defaultCollapsed = true,
}: {
  toolName: string;
  summary: string;
  status: ToolPartStatus;
  args?: unknown;
  resultText?: string;
  defaultCollapsed?: boolean;
}) {
  const [open, setOpen] = useState(!defaultCollapsed);
  const path =
    typeof args === "object" &&
    args != null &&
    "path" in args &&
    typeof (args as { path?: string }).path === "string"
      ? (args as { path: string }).path
      : undefined;

  const StatusIcon =
    status === "running"
      ? () => <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-500" />
      : status === "error"
        ? () => <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
        : () => <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />;

  return (
    <div className="my-1.5 rounded-lg border border-border/40 bg-muted/15 overflow-hidden text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-muted/30"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <FileCode2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <StatusIcon />
        <span className="flex-1 min-w-0 truncate font-medium text-foreground/90">
          {path ? (
            <>
              <span className="text-muted-foreground">{toolName.replace(/_/g, " ")} · </span>
              {path}
            </>
          ) : (
            summary
          )}
        </span>
      </button>
      {open && resultText?.trim() ? (
        <pre className="max-h-48 overflow-auto border-t border-border/30 px-2.5 py-2 text-[10px] font-mono text-muted-foreground whitespace-pre-wrap break-words">
          {resultText.trim()}
        </pre>
      ) : null}
    </div>
  );
}
