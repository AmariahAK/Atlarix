import { Terminal } from "lucide-react";
import type { ToolPartStatus } from "@/lib/chat/assistant-message-parts";
import { CollapsedScrollSection } from "./CollapsedScrollSection";

export function InlineTerminalToolCard({
  summary,
  status,
  resultText,
  defaultCollapsed = true,
}: {
  summary: string;
  status: ToolPartStatus;
  resultText?: string;
  defaultCollapsed?: boolean;
}) {
  return (
    <CollapsedScrollSection
      summary={`${summary}`}
      status={status === "success" ? "done" : status}
      defaultCollapsed={defaultCollapsed}
    >
      <div className="flex items-center gap-2 pb-2 text-[10px] text-muted-foreground font-mono">
        <Terminal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate">terminal output</span>
      </div>
      {resultText?.trim() ? (
        <pre className="text-[10px] text-muted-foreground whitespace-pre-wrap break-words font-mono">
          {resultText.trim()}
        </pre>
      ) : null}
    </CollapsedScrollSection>
  );
}
