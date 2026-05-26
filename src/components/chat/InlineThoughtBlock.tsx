import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export function InlineThoughtBlock({
  content,
  isStreaming,
}: {
  content: string;
  isStreaming: boolean;
}) {
  const [open, setOpen] = useState(isStreaming);

  useEffect(() => {
    if (!isStreaming) setOpen(false);
  }, [isStreaming]);

  if (!content.trim()) return null;

  const lineCount = content.split("\n").length;

  return (
    <div className="my-2 rounded-lg border border-emerald-500/25 bg-emerald-500/5 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs text-emerald-200/90 hover:bg-emerald-500/10"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="font-medium">
          Thoughts
          {!open ? (
            <span className="font-normal text-muted-foreground">
              {" "}
              · {lineCount} {lineCount === 1 ? "line" : "lines"}
            </span>
          ) : null}
        </span>
      </button>
      {open ? (
        <div
          className={cn(
            "border-t border-emerald-500/20 px-2.5 py-2 text-xs text-muted-foreground",
            "whitespace-pre-wrap break-words max-h-48 overflow-y-auto",
          )}
        >
          {content}
        </div>
      ) : null}
    </div>
  );
}
