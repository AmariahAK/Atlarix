import { SmartDiffView } from "@/components/SmartDiffView";
import type { ToolExpandView } from "@/lib/chat/tool-expand-view";
import { CopyButton } from "./ToolCardActions";

export function ToolDiffExpand({
  view,
}: {
  view: Extract<ToolExpandView, { kind: "diff" }>;
}) {
  const hasFullDiff = view.oldContent.length > 0 || view.newContent.length > 0;

  if (!hasFullDiff && view.snippetFallback) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2 px-1">
          <div className="flex items-center gap-2 text-[10px] min-w-0">
            <span className="font-medium text-foreground truncate">
              {view.fileName}
            </span>
            {view.addedCount != null && view.addedCount > 0 ? (
              <span className="text-emerald-600 dark:text-emerald-500">
                +{view.addedCount}
              </span>
            ) : null}
            {view.removedCount != null && view.removedCount > 0 ? (
              <span className="text-red-600 dark:text-red-400">
                -{view.removedCount}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            <CopyButton text={view.snippetFallback} />
          </div>
        </div>
        <pre className="max-h-32 overflow-auto rounded-md border border-border bg-muted/50 dark:bg-background/50 p-2 font-mono text-[10px] text-foreground/85 dark:text-muted-foreground whitespace-pre-wrap">
          {view.snippetFallback}
        </pre>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {view.path ? (
        <div className="flex items-center justify-end px-1">
          <CopyButton text={view.newContent} label="Copy new content" />
        </div>
      ) : null}
      <SmartDiffView
        path={view.path}
        oldContent={view.oldContent}
        newContent={view.newContent}
        operation={view.operation}
        maxHeight="max-h-48"
        // Computed in main; without it this card re-ran a whole-file Myers diff
        // on the UI thread every render.
        precomputedHunks={view.precomputedHunks}
      />
    </div>
  );
}
