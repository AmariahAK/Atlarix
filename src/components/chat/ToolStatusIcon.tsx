import { CheckCircle2, XCircle } from "lucide-react";
import type { InlineTimelineToolStatus } from "@/lib/chat/inline-timeline";

/** Shared status glyph for stream tool / collapsed cards (running / done / error). */
export function ToolStatusIcon({
  status,
}: {
  status: InlineTimelineToolStatus;
}) {
  if (status === "running") {
    // Calm pulsing dot — the running label shimmers, so no spinner needed.
    return (
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
      </span>
    );
  }
  if (status === "error") {
    return <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />;
  }
  return (
    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-500" />
  );
}
