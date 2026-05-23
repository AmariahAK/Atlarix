import { useMemo } from "react";
import { useAtomValue } from "jotai";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { workspacePlanPanelAtom } from "@/atoms/sourceAtoms";
import { PlanChangesCard } from "./PlanChangesCard";
import { mergeLedgerIntoPlanMarkdown } from "@/lib/plan-changes/merge-ledger-into-plan-md";
import { CHAT_MESSAGE_MARKDOWN_PROSE } from "@/components/chat/AtlarixMarkdownParser";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

export function PlanExecutionPanel() {
  const panel = useAtomValue(workspacePlanPanelAtom);

  const displayMarkdown = useMemo(
    () =>
      panel.markdown
        ? mergeLedgerIntoPlanMarkdown(panel.markdown, panel.ledger)
        : null,
    [panel.markdown, panel.ledger],
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-3 space-y-4">
          <PlanChangesCard changes={panel.changes} />
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <div className="px-3 py-2 border-b border-border font-medium text-sm flex items-center justify-between gap-2">
              <span>ATLARIX Plan</span>
              {panel.ledger?.status === "in_progress" ? (
                <span className="text-xs text-primary font-normal">● Live</span>
              ) : null}
            </div>
            <div className="px-3 py-3">
              {displayMarkdown ? (
                <div className={cn(CHAT_MESSAGE_MARKDOWN_PROSE, "text-sm max-w-none")}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayMarkdown}</ReactMarkdown>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No plan file yet. In Plan mode, ask the agent to write{" "}
                  <code className="text-xs">.atlarix/ATLARIX_PLAN.md</code>.
                </p>
              )}
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
