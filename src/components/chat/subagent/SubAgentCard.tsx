import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import { streamToolCardShell } from "@/components/chat/stream-item-styles";
import type { HandoffAgentRole } from "@/components/chat/HandoffResultCard";
import { HandoffResultCard } from "@/components/chat/HandoffResultCard";

export function SubAgentCard({
  agentType,
  scope,
  summary,
  status,
  handoff,
}: {
  agentType: string;
  scope?: string;
  summary?: string;
  status: "running" | "done" | "error";
  handoff?: {
    agentRole: HandoffAgentRole;
    summary: string;
    structuredPayload?: unknown;
    validationStatus: "success" | "fallback";
  };
}) {
  const [expanded, setExpanded] = useState(false);

  const preview = useMemo(() => {
    const line = (handoff?.summary ?? summary ?? "").trim().split(/\r?\n/)[0] ?? "";
    return line.length > 120 ? `${line.slice(0, 120)}…` : line;
  }, [handoff?.summary, summary]);

  if (handoff && status !== "running") {
    return (
      <HandoffResultCard
        agentRole={handoff.agentRole}
        summary={handoff.summary}
        structuredPayload={handoff.structuredPayload}
        validationStatus={handoff.validationStatus}
      />
    );
  }

  const statusLabel =
    status === "running" ? "Running" : status === "error" ? "Error" : "Done";

  return (
    <div
      className={cn(
        streamToolCardShell,
        "my-1.5 rounded-lg border px-3 py-2",
        status === "error" && "border-destructive/40",
      )}
    >
      <button
        type="button"
        className="flex w-full items-start gap-2 text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <Bot className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium capitalize">{agentType}</span>
            {scope ? (
              <span className="text-[10px] text-muted-foreground truncate max-w-[14rem]">
                {scope}
              </span>
            ) : null}
            <span
              className={cn(
                "text-[10px] rounded px-1.5 py-0.5 border",
                status === "running" && "border-amber-500/40 text-amber-700 dark:text-amber-200",
                status === "done" && "border-emerald-500/35 text-emerald-800 dark:text-emerald-200",
                status === "error" && "border-destructive/40 text-destructive",
              )}
            >
              {statusLabel}
            </span>
          </div>
          {preview ? (
            <p className="mt-1 text-[11px] text-muted-foreground line-clamp-2">{preview}</p>
          ) : null}
        </div>
        {summary && summary.length > preview.length ? (
          expanded ? (
            <ChevronUp className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          )
        ) : null}
      </button>
      {expanded && summary ? (
        <pre className="mt-2 max-h-48 overflow-auto text-[10px] whitespace-pre-wrap break-words text-muted-foreground border-t border-border/40 pt-2">
          {summary}
        </pre>
      ) : null}
    </div>
  );
}
