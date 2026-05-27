import type { ToolExpandView } from "@/lib/chat/tool-expand-view";
import { ToolFileRow } from "./ToolFileRow";

export function ToolFileListExpand({
  view,
}: {
  view: Extract<ToolExpandView, { kind: "file_list" }>;
}) {
  const label = `${view.total} file${view.total === 1 ? "" : "s"}${
    view.truncated ? " (truncated)" : ""
  }`;

  return (
    <div className="space-y-1">
      <div className="text-[10px] text-muted-foreground px-1">{label}</div>
      <div className="max-h-56 overflow-y-auto">
        {view.entries.map((e) => (
          <ToolFileRow
            key={e.path}
            fileName={e.fileName}
            directory={e.directory}
            entryType={e.entryType}
          />
        ))}
      </div>
      {view.moreCount != null && view.moreCount > 0 ? (
        <div className="text-[10px] text-muted-foreground px-1">
          +{view.moreCount} more
        </div>
      ) : null}
    </div>
  );
}
