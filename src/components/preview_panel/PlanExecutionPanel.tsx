import { useCallback, useEffect, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { activeChatIdAtom } from "@/atoms/chatAtoms";
import { useStreamChat } from "@/hooks/useStreamChat";
import { useSettings } from "@/hooks/useSettings";
import { settingsPatchForWorkMode } from "@/lib/work-mode";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ClipboardList, Hammer, CircleCheck, Loader2 } from "lucide-react";
import { workspacePlanPanelAtom } from "@/atoms/sourceAtoms";
import { PlanChangesCard } from "./PlanChangesCard";
import { CHAT_MESSAGE_MARKDOWN_PROSE } from "@/components/chat/AtlarixMarkdownParser";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { IpcClient } from "@/ipc/ipc_client";
import type { PlanArtifactStatus } from "@/db/schema";
import { Button } from "@/components/ui/button";
import { PlanChecklistProgress } from "@/components/chat/PlanArtifactCard";

function statusLabel(status: PlanArtifactStatus | null): string {
  if (status === "building") return "Building";
  if (status === "built") return "Built";
  return "Plan";
}

function StatusHeaderIcon({ status }: { status: PlanArtifactStatus | null }) {
  if (status === "building") return <Hammer className="h-4 w-4" aria-hidden />;
  if (status === "built") return <CircleCheck className="h-4 w-4 text-emerald-500" aria-hidden />;
  return <ClipboardList className="h-4 w-4" aria-hidden />;
}

export function PlanExecutionPanel() {
  const [panel, setPanel] = useAtom(workspacePlanPanelAtom);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const activeChatId = useAtomValue(activeChatIdAtom);
  const { streamMessage, isStreaming } = useStreamChat();
  const { updateSettings } = useSettings();

  useEffect(() => {
    setDraft(panel.content ?? "");
  }, [panel.planId, panel.content]);

  const saveDraft = useCallback(async () => {
    if (!panel.planId || !draft.trim()) return;
    setSaving(true);
    try {
      const updated = await IpcClient.getInstance().updatePlanArtifactContent(
        panel.planId,
        draft,
      );
      setPanel((prev) => ({
        ...prev,
        content: updated.content,
        planStatus: updated.planStatus,
      }));
    } catch (e) {
      console.error("Failed to save plan:", e);
    } finally {
      setSaving(false);
    }
  }, [panel.planId, draft, setPanel]);

  const setStatus = async (planStatus: PlanArtifactStatus) => {
    if (!panel.planId) return;
    try {
      const updated = await IpcClient.getInstance().setPlanArtifactStatus(
        panel.planId,
        planStatus,
      );
      setPanel((prev) => ({
        ...prev,
        planStatus: updated.planStatus,
      }));
    } catch (e) {
      console.error("Failed to update plan status:", e);
    }
  };

  const handleBuild = async () => {
    if (!panel.planId) return;
    await updateSettings(settingsPatchForWorkMode("build"));
    await setStatus("building");
    if (activeChatId != null && !isStreaming) {
      void streamMessage({
        prompt:
          "Implement the plan in the Plan panel step by step. Follow the phases and items in order.",
        chatId: activeChatId,
        workModeOverride: "build",
      });
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-3 space-y-4">
          <PlanChangesCard changes={panel.changes} />
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <div className="px-3 py-2 border-b border-border font-medium text-sm flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <StatusHeaderIcon status={panel.planStatus} />
                {panel.planId ? statusLabel(panel.planStatus) : "Plan"}
              </span>
              {panel.planStatus === "building" ? (
                <span className="text-xs text-primary font-normal flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  Live
                </span>
              ) : null}
            </div>
            <div className="px-3 py-3 space-y-3">
              {panel.planId ? (
                <>
                  <PlanChecklistProgress
                    content={panel.content ?? ""}
                    planStatus={panel.planStatus ?? "plan"}
                  />
                  <textarea
                    className="w-full min-h-[200px] text-sm font-mono bg-muted/30 rounded-md border border-border p-2 resize-y"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => void saveDraft()}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={saving}
                      onClick={() => void saveDraft()}
                    >
                      {saving ? "Saving…" : "Save"}
                    </Button>
                    {panel.planStatus === "plan" ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="default"
                        className="gap-1"
                        disabled={isStreaming}
                        onClick={() => void handleBuild()}
                      >
                        <Hammer className="h-3.5 w-3.5" aria-hidden />
                        Build
                      </Button>
                    ) : null}
                    {panel.planStatus === "building" ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="default"
                        className="gap-1"
                        disabled={isStreaming || activeChatId == null}
                        onClick={() => void handleBuild()}
                      >
                        <Hammer className="h-3.5 w-3.5" aria-hidden />
                        Continue build
                      </Button>
                    ) : null}
                    {panel.planStatus === "building" ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => void setStatus("built")}
                      >
                        Mark built
                      </Button>
                    ) : null}
                  </div>
                  {draft.trim() ? (
                    <div className={cn(CHAT_MESSAGE_MARKDOWN_PROSE, "text-sm max-w-none opacity-90 border-t pt-3")}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{draft}</ReactMarkdown>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No plan selected. Click a plan card in chat to open it here, or create one in
                  Plan mode with <code className="text-xs">write_implementation_plan</code>.
                </p>
              )}
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
