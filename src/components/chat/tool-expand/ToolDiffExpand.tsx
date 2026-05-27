import { SmartDiffView } from "@/components/SmartDiffView";
import type { ToolExpandView } from "@/lib/chat/tool-expand-view";

export function ToolDiffExpand({
  view,
}: {
  view: Extract<ToolExpandView, { kind: "diff" }>;
}) {
  const hasFullDiff =
    view.oldContent.length > 0 || view.newContent.length > 0;

  if (!hasFullDiff && view.snippetFallback) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-[10px] px-1">
          <span className="font-medium text-foreground">{view.fileName}</span>
          {view.addedCount != null && view.addedCount > 0 ? (
            <span className="text-emerald-500">+{view.addedCount}</span>
          ) : null}
          {view.removedCount != null && view.removedCount > 0 ? (
            <span className="text-red-400">-{view.removedCount}</span>
          ) : null}
        </div>
        <pre className="max-h-32 overflow-auto rounded-md border border-border bg-muted/50 dark:bg-background/50 p-2 font-mono text-[10px] text-foreground/85 dark:text-muted-foreground whitespace-pre-wrap">
          {view.snippetFallback}
        </pre>
      </div>
    );
  }

  return (
    <SmartDiffView
      path={view.path}
      oldContent={view.oldContent}
      newContent={view.newContent}
      operation={view.operation}
      maxHeight="max-h-48"
    />
  );
}
