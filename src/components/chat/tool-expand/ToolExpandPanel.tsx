import type { ToolExpandView } from "@/lib/chat/tool-expand-view";
import { ToolDiffExpand } from "./ToolDiffExpand";
import { ToolFileListExpand } from "./ToolFileListExpand";
import { ToolMatchListExpand } from "./ToolMatchListExpand";
import { ToolReadSnippetExpand } from "./ToolReadSnippetExpand";
import { cn } from "@/lib/utils";

export function ToolExpandPanel({
  view,
  className,
}: {
  view: ToolExpandView;
  className?: string;
}) {
  if (view.kind === "none") return null;

  return (
    <div className={cn("border-t border-border px-2.5 py-2", className)}>
      {view.kind === "file_list" ? <ToolFileListExpand view={view} /> : null}
      {view.kind === "match_list" ? <ToolMatchListExpand view={view} /> : null}
      {view.kind === "read_snippet" ? <ToolReadSnippetExpand view={view} /> : null}
      {view.kind === "diff" ? <ToolDiffExpand view={view} /> : null}
      {view.kind === "text" ? (
        <pre
          className={cn(
            "text-[11px] leading-relaxed whitespace-pre-wrap break-words font-sans",
            view.isError
              ? "text-destructive"
              : "text-foreground/85 dark:text-muted-foreground",
          )}
        >
          {view.body}
        </pre>
      ) : null}
    </div>
  );
}
