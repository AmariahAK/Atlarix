import type { ToolExpandView } from "@/lib/chat/tool-expand-view";
import { Wrench } from "lucide-react";
import { ToolScrollableBody } from "./ToolScrollableBody";

export function ToolMcpResultExpand({
  view,
}: {
  view: Extract<ToolExpandView, { kind: "mcp_result" }>;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 px-1 text-[10px] text-muted-foreground">
        <Wrench className="h-3 w-3 shrink-0" />
        <span className="font-mono break-all text-foreground/80">
          {view.server}
          {view.tool ? `/${view.tool}` : ""}
        </span>
      </div>
      {view.body ? <ToolScrollableBody text={view.body} /> : null}
    </div>
  );
}
