import React, { useMemo, useState } from "react";
import {
  CheckCircle,
  ChevronsDownUp,
  ChevronsUpDown,
  Wrench,
  X,
} from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CodeHighlight } from "./CodeHighlight";
import { cn } from "@/lib/utils";

export type McpToolMessageKind = "result" | "call";

interface McpToolMessageCardProps {
  kind: McpToolMessageKind;
  serverName?: string;
  toolName?: string;
  children?: React.ReactNode;
}

export const McpToolMessageCard: React.FC<McpToolMessageCardProps> = ({
  kind,
  serverName = "",
  toolName = "",
  children,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const raw = typeof children === "string" ? children : String(children ?? "");

  const prettyJson = useMemo(() => {
    if (!expanded) return "";
    try {
      const parsed = JSON.parse(raw);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return raw;
    }
  }, [expanded, raw]);

  if (dismissed) {
    return null;
  }

  const isResult = kind === "result";
  const label = isResult ? "Tool Result" : "Tool Call";
  const Icon = isResult ? CheckCircle : Wrench;
  const accent = isResult ? "text-emerald-600" : "text-blue-600";
  const badgeBg = isResult
    ? "bg-emerald-50 dark:bg-zinc-800 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-zinc-700"
    : "bg-blue-50 dark:bg-zinc-800 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-zinc-700";

  return (
    <Card className="my-2 overflow-hidden">
      <CardHeader
        className="flex flex-row items-center gap-2 py-2 px-3 cursor-pointer select-none"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className={cn("flex items-center gap-1 text-xs font-semibold shrink-0", accent)}>
          <Icon size={14} className={accent} />
          <span>{label}</span>
        </div>
        {serverName ? (
          <span
            className={cn(
              "text-xs px-2 py-0.5 rounded-full border truncate max-w-[40%]",
              badgeBg,
            )}
            title={serverName}
          >
            {serverName}
          </span>
        ) : null}
        {toolName ? (
          <span
            className="text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-zinc-800 text-gray-700 dark:text-gray-200 border border-border truncate max-w-[40%]"
            title={toolName}
          >
            {toolName}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-0.5 shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            aria-label={expanded ? "Collapse" : "Expand"}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
          >
            {expanded ? (
              <ChevronsDownUp size={16} className="text-muted-foreground" />
            ) : (
              <ChevronsUpDown size={16} className="text-muted-foreground" />
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            aria-label="Dismiss"
            onClick={(e) => {
              e.stopPropagation();
              setDismissed(true);
            }}
          >
            <X size={16} className="text-muted-foreground" />
          </Button>
        </div>
      </CardHeader>
      {expanded ? (
        <CardContent className="pt-0 pb-3 px-3" onClick={(e) => e.stopPropagation()}>
          <ScrollArea className="max-h-[min(320px,40vh)] w-full rounded-md border bg-muted/30">
            <div className="overflow-x-auto p-2 min-w-0">
              <CodeHighlight className="language-json">{prettyJson}</CodeHighlight>
            </div>
          </ScrollArea>
        </CardContent>
      ) : null}
    </Card>
  );
};
