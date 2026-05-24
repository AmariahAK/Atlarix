import { useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { workspacePlanPanelAtom } from "@/atoms/sourceAtoms";
import {
  chatMessagesByIdAtom,
  livePlanUpdateByAssistantMessageIdAtom,
  selectedChatIdAtom,
} from "@/atoms/chatAtoms";
import { PlanChangesCard } from "./PlanChangesCard";
import { mergeLedgerIntoPlanMarkdown } from "@/lib/plan-changes/merge-ledger-into-plan-md";
import { extractPlanFromContent } from "@/lib/plan-cards/plan-card-renderer";
import { CHAT_MESSAGE_MARKDOWN_PROSE } from "@/components/chat/AtlarixMarkdownParser";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight } from "lucide-react";

function planCardToMarkdown(data: NonNullable<ReturnType<typeof extractPlanFromContent>>): string {
  const lines: string[] = [`# ${data.title || "Plan"}`];
  for (const phase of data.phases ?? []) {
    lines.push(`\n## ${phase.title}`);
    for (const task of phase.tasks ?? []) {
      const mark =
        task.status === "done" ? "x" : task.status === "in_progress" ? "~" : " ";
      lines.push(`- [${mark}] ${task.label}`);
    }
  }
  return lines.join("\n");
}

export function PlanExecutionPanel() {
  const panel = useAtomValue(workspacePlanPanelAtom);
  const chatId = useAtomValue(selectedChatIdAtom);
  const messagesByChatId = useAtomValue(chatMessagesByIdAtom);
  const livePlanByMessageId = useAtomValue(livePlanUpdateByAssistantMessageIdAtom);
  const [showFilePlan, setShowFilePlan] = useState(false);

  const messages = chatId != null ? (messagesByChatId.get(chatId) ?? []) : [];

  const liveFromChat = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      const live = livePlanByMessageId.get(m.id);
      if (live?.markdown?.trim()) return live.markdown;
      const card = extractPlanFromContent(String(m.content ?? ""));
      if (card) return planCardToMarkdown(card);
      const tag = String(m.content ?? "").match(/```atlarix-plan\s*([\s\S]*?)```/i);
      if (tag?.[1]?.trim()) return tag[1].trim();
    }
    return null;
  }, [messages, livePlanByMessageId]);

  const ledgerMarkdown = useMemo(() => {
    if (!panel.ledger?.steps?.length) return null;
    const lines = panel.ledger.steps.map((s, i) => {
      const mark =
        s.status === "done" ? "x" : s.status === "in_progress" ? "~" : s.status === "failed" ? "!" : " ";
      return `${i + 1}. [${mark}] ${s.description}`;
    });
    return lines.join("\n");
  }, [panel.ledger]);

  const primaryMarkdown = liveFromChat ?? ledgerMarkdown;
  const fileMarkdown = panel.markdown?.trim() ? panel.markdown : null;

  const displayMarkdown = useMemo(() => {
    if (primaryMarkdown) {
      return fileMarkdown && primaryMarkdown !== fileMarkdown
        ? `${primaryMarkdown}\n\n---\n\n`
        : primaryMarkdown;
    }
    return fileMarkdown
      ? mergeLedgerIntoPlanMarkdown(fileMarkdown, panel.ledger)
      : null;
  }, [primaryMarkdown, fileMarkdown, panel.ledger]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-3 space-y-4">
          <PlanChangesCard changes={panel.changes} />
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <div className="px-3 py-2 border-b border-border font-medium text-sm flex items-center justify-between gap-2">
              <span>{liveFromChat ? "Live plan" : ledgerMarkdown ? "Plan progress" : "Plan"}</span>
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
                  No live plan yet. In Plan mode, the agent can emit an{" "}
                  <code className="text-xs">atlarix-plan</code> block or use{" "}
                  <code className="text-xs">write_implementation_plan</code>.
                </p>
              )}
            </div>
          </div>

          {fileMarkdown ? (
            <div className="rounded-lg border border-border/60 bg-muted/20 overflow-hidden">
              <button
                type="button"
                className="w-full px-3 py-2 flex items-center gap-2 text-sm text-muted-foreground hover:bg-muted/40"
                onClick={() => setShowFilePlan((v) => !v)}
              >
                {showFilePlan ? (
                  <ChevronDown className="h-4 w-4 shrink-0" />
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0" />
                )}
                <span>ATLARIX_PLAN.md on disk</span>
              </button>
              {showFilePlan ? (
                <div className="px-3 pb-3 border-t border-border/60">
                  <div className={cn(CHAT_MESSAGE_MARKDOWN_PROSE, "text-sm max-w-none opacity-90")}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {mergeLedgerIntoPlanMarkdown(fileMarkdown, panel.ledger) ?? fileMarkdown}
                    </ReactMarkdown>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}
