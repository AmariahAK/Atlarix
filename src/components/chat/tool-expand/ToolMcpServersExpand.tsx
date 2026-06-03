import type { ToolExpandView } from "@/lib/chat/tool-expand-view";
import { Server, Wrench, ShieldAlert, AlertCircle } from "lucide-react";

export function ToolMcpServersExpand({
  view,
}: {
  view: Extract<ToolExpandView, { kind: "mcp_servers" }>;
}) {
  const serverCount = view.servers.length;
  const toolCount = view.servers.reduce((s, srv) => s + srv.tools.length, 0);

  return (
    <div className="space-y-2">
      {serverCount > 0 ? (
        <div className="text-[10px] text-muted-foreground px-1">
          {serverCount} server{serverCount === 1 ? "" : "s"}
          {toolCount > 0
            ? ` · ${toolCount} tool${toolCount === 1 ? "" : "s"}`
            : ""}
        </div>
      ) : null}

      {view.message && serverCount === 0 ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground px-1">
          {view.message}
        </p>
      ) : null}

      <div className="max-h-64 overflow-y-auto space-y-2">
        {view.servers.map((srv) => (
          <div
            key={srv.id ?? srv.name}
            className="rounded-md border border-border bg-muted/40 dark:bg-background/40 px-2 py-1.5"
          >
            <div className="flex items-center gap-1.5">
              <Server className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="text-[11px] font-medium text-foreground/90 break-all">
                {srv.name}
              </span>
              {srv.transport ? (
                <span className="text-[9px] uppercase tracking-wide text-muted-foreground rounded bg-muted px-1 py-px">
                  {srv.transport}
                </span>
              ) : null}
              {srv.scope ? (
                <span className="text-[9px] uppercase tracking-wide text-muted-foreground rounded bg-muted px-1 py-px">
                  {srv.scope}
                </span>
              ) : null}
            </div>

            {srv.needsOAuth ? (
              <div className="mt-1 flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-500">
                <ShieldAlert className="h-3 w-3 shrink-0" />
                Needs authorization
              </div>
            ) : null}

            {srv.error ? (
              <div className="mt-1 flex items-start gap-1 text-[10px] text-destructive">
                <AlertCircle className="h-3 w-3 shrink-0 mt-px" />
                <span className="break-words">{srv.error}</span>
              </div>
            ) : srv.tools.length > 0 ? (
              <ul className="mt-1 space-y-0.5 pl-1">
                {srv.tools.map((t) => (
                  <li
                    key={t.name}
                    className="flex items-start gap-1 text-[10px] leading-snug"
                  >
                    <Wrench className="h-2.5 w-2.5 shrink-0 mt-0.5 text-muted-foreground" />
                    <span className="font-mono text-foreground/80 break-all">
                      {t.name}
                    </span>
                    {t.description ? (
                      <span className="text-muted-foreground line-clamp-1">
                        — {t.description}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="mt-1 text-[10px] text-muted-foreground pl-1">
                No tools exposed
              </div>
            )}
          </div>
        ))}
      </div>

      {view.usage ? (
        <p className="text-[10px] text-muted-foreground px-1 pt-0.5">
          {view.usage}
        </p>
      ) : null}
    </div>
  );
}
