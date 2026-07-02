import type { ToolExpandView } from "@/lib/chat/tool-expand-view";
import { ToolFileRow } from "./ToolFileRow";
import { OpenFileButton } from "./ToolCardActions";
import { ToolScrollableBody } from "./ToolScrollableBody";

export function ToolReadSnippetExpand({
  view,
}: {
  view: Extract<ToolExpandView, { kind: "read_snippet" }>;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <ToolFileRow
          fileName={view.fileName}
          directory={view.directory}
          trailing={view.lineRange}
        />
        {view.path ? (
          <div className="shrink-0">
            <OpenFileButton path={view.path} line={view.startLine} />
          </div>
        ) : null}
      </div>
      <div className="rounded-md border border-border bg-muted/50 dark:bg-background/50 p-2">
        <ToolScrollableBody text={view.snippet} />
      </div>
    </div>
  );
}
