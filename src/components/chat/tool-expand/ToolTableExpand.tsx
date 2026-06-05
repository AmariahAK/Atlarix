import type { ToolExpandView } from "@/lib/chat/tool-expand-view";
import { Table2 } from "lucide-react";

/** Spreadsheet/CSV table card for read_attachment results. */
export function ToolTableExpand({
  view,
}: {
  view: Extract<ToolExpandView, { kind: "table" }>;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 px-1 text-[10px] text-muted-foreground">
        <Table2 className="h-3 w-3 shrink-0" />
        <span className="font-mono break-all text-foreground/80">
          {view.fileName}
          {view.sheetName ? ` · ${view.sheetName}` : ""}
        </span>
        <span className="ml-auto shrink-0 tabular-nums">
          {view.totalRows.toLocaleString()} row{view.totalRows === 1 ? "" : "s"}
        </span>
      </div>
      <div className="max-h-64 overflow-auto rounded border border-border">
        <table className="w-full border-collapse text-[11px]">
          {view.headers.length > 0 ? (
            <thead className="sticky top-0 bg-muted/80 backdrop-blur">
              <tr>
                {view.headers.map((h, i) => (
                  <th
                    key={i}
                    className="border-b border-border px-2 py-1 text-left font-medium text-foreground/80 whitespace-nowrap"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
          ) : null}
          <tbody>
            {view.rows.map((row, ri) => (
              <tr key={ri} className="odd:bg-muted/30">
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    className="border-b border-border/50 px-2 py-1 align-top text-foreground/90 max-w-64 truncate"
                    title={cell}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {view.moreCount ? (
        <p className="px-1 text-[10px] text-muted-foreground">
          +{view.moreCount.toLocaleString()} more row
          {view.moreCount === 1 ? "" : "s"} (full data available to the model)
        </p>
      ) : null}
    </div>
  );
}
