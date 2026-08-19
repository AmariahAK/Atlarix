import type { ToolExpandView } from "@/lib/chat/tool-expand-view";
import { ToolFileRow } from "./ToolFileRow";

function matchLabel(
  n: number,
  symbol?: { name: string },
  binary?: boolean,
): string {
  // ripgrep found the pattern but will not print lines from a file holding a
  // NUL byte. Say that, rather than a match count for matches nobody can see.
  if (binary) return "-- binary · matched";
  const matches = `${n} match${n === 1 ? "" : "es"}`;
  return symbol ? `${symbol.name} · ${matches}` : `-- ${matches}`;
}

export function ToolMatchListExpand({
  view,
}: {
  view: Extract<ToolExpandView, { kind: "match_list" }>;
}) {
  return (
    <div className="space-y-0.5">
      <div className="text-[10px] text-muted-foreground px-1 mb-1">
        {view.totalMatches} match{view.totalMatches === 1 ? "" : "es"} across{" "}
        {view.files.length} file{view.files.length === 1 ? "" : "s"}
      </div>
      <div className="max-h-56 overflow-y-auto rounded-md border border-border bg-muted/40 dark:bg-background/40">
        {view.files.map((f) => (
          <ToolFileRow
            key={f.path}
            fileName={f.fileName}
            directory={f.directory}
            trailing={matchLabel(f.matchCount, f.enclosingSymbol, f.binary)}
          />
        ))}
      </div>
      {view.moreCount != null && view.moreCount > 0 ? (
        <div className="text-[10px] text-muted-foreground px-1">
          +{view.moreCount} more files
        </div>
      ) : null}
    </div>
  );
}
