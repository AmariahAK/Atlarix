import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import type { ToolExpandView } from "@/lib/chat/tool-expand-view";
import { CopyButton } from "./ToolCardActions";

/** Default-open command result: command + exit code + last lines of output. */
const CLAMP_LINES = 10;

export function ToolCommandExpand({
  view,
}: {
  view: Extract<ToolExpandView, { kind: "command" }>;
}) {
  const [showFull, setShowFull] = useState(false);
  const lines = useMemo(() => view.body.split(/\r?\n/), [view.body]);
  const clamped = !showFull && lines.length > CLAMP_LINES;
  const visible = clamped ? lines.slice(-CLAMP_LINES) : lines;
  const failed = view.exitCode != null && view.exitCode !== 0;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 px-1 min-w-0">
        <div className="flex items-center gap-2 text-[10px] min-w-0">
          {view.command ? (
            <code className="truncate font-mono text-foreground/80">
              $ {view.command}
            </code>
          ) : null}
          {view.exitCode != null ? (
            <span
              className={cn(
                "shrink-0 rounded px-1 py-0.5 font-medium tabular-nums",
                failed
                  ? "bg-red-500/10 text-red-600 dark:text-red-400"
                  : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-500",
              )}
            >
              exit {view.exitCode}
            </span>
          ) : null}
        </div>
        <CopyButton text={view.body} />
      </div>
      <pre
        className={cn(
          "max-h-56 overflow-auto rounded-md border border-border bg-muted/50 dark:bg-background/50 p-2 font-mono text-[10px] whitespace-pre-wrap",
          failed
            ? "text-red-600/90 dark:text-red-300/90"
            : "text-foreground/85 dark:text-muted-foreground",
        )}
      >
        {visible.join("\n")}
      </pre>
      {lines.length > CLAMP_LINES ? (
        <button
          type="button"
          onClick={() => setShowFull((s) => !s)}
          className="px-1 text-[10px] text-muted-foreground hover:text-foreground"
        >
          {showFull
            ? "Show last lines only"
            : `Show full output (${lines.length} lines)`}
        </button>
      ) : null}
    </div>
  );
}
