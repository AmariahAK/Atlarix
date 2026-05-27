import type { ToolExpandView } from "@/lib/chat/tool-expand-view";
import { ToolFileRow } from "./ToolFileRow";

export function ToolReadSnippetExpand({
  view,
}: {
  view: Extract<ToolExpandView, { kind: "read_snippet" }>;
}) {
  return (
    <div className="space-y-2">
      <ToolFileRow
        fileName={view.fileName}
        directory={view.directory}
        trailing={view.lineRange}
      />
      <pre className="max-h-48 overflow-auto rounded-md border border-border bg-muted/50 dark:bg-background/50 p-2 font-mono text-[10px] leading-relaxed text-foreground/85 dark:text-muted-foreground whitespace-pre-wrap break-words">
        {view.snippet}
      </pre>
    </div>
  );
}
