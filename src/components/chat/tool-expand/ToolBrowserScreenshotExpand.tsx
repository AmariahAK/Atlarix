import type { ToolExpandView } from "@/lib/chat/tool-expand-view";
import { Globe } from "lucide-react";

/** Screenshot card for browser_screenshot results (untrusted page render). */
export function ToolBrowserScreenshotExpand({
  view,
}: {
  view: Extract<ToolExpandView, { kind: "browser_screenshot" }>;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 px-1 text-[10px] text-muted-foreground">
        <Globe className="h-3 w-3 shrink-0" />
        <span className="truncate font-mono text-foreground/80" title={view.url}>
          {view.title || view.url}
        </span>
      </div>
      <div className="max-h-72 overflow-auto rounded border border-border">
        <img
          src={view.dataUrl}
          alt={`Screenshot of ${view.title || view.url}`}
          className="w-full"
        />
      </div>
    </div>
  );
}
