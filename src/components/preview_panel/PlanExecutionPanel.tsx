import { useCallback, useEffect, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { activeChatIdAtom } from "@/atoms/chatAtoms";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { activeWorkspaceSessionIdAtom } from "@/atoms/sessionAtoms";
import { useStreamChat } from "@/hooks/useStreamChat";
import { useSettings } from "@/hooks/useSettings";
import { BUILD_FROM_PLAN_PROMPT, settingsPatchForWorkMode } from "@/lib/work-mode";
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
import type { PlanArtifactPayload } from "@/ipc/utils/emit_plan_artifact";
import { Button } from "@/components/ui/button";
import {
  PlanChecklistProgress,
  planArtifactTitleFromContent,
} from "@/components/chat/PlanArtifactCard";

function statusLabel(status: PlanArtifactStatus | null): string {
  if (status === "building") return "Building";
  if (status === "built") return "Built";
  return "Plan";
}

function StatusHeaderIcon({ status }: { status: PlanArtifactStatus | null }) {
  if (status === "building") return <Hammer className="h-4 w-4" aria-hidden />;
  if (status === "built")
    return <CircleCheck className="h-4 w-4 text-emerald-500" aria-hidden />;
  return <ClipboardList className="h-4 w-4" aria-hidden />;
}

export function PlanExecutionPanel() {
  const [panel, setPanel] = useAtom(workspacePlanPanelAtom);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [sessionPlans, setSessionPlans] = useState<PlanArtifactPayload[]>([]);
  const [earlierPlans, setEarlierPlans] = useState<
    Array<PlanArtifactPayload & { sessionTitle: string | null }>
  >([]);
  const activeChatId = useAtomValue(activeChatIdAtom);
  const workspaceId = useAtomValue(selectedAppIdAtom);
  const activeSessionId = useAtomValue(activeWorkspaceSessionIdAtom);
  const { streamMessage, isStreaming } = useStreamChat();
  const { updateSettings } = useSettings();

  useEffect(() => {
    setDraft(panel.content ?? "");
  }, [panel.planId, panel.content]);

  // The session's other plans, so the panel can say which one it is showing and
  // let you move between them. Older plans were always reachable as inline cards
  // in the transcript; what was missing was naming and switching.
  useEffect(() => {
    const sessionId = panel.sessionId;
    if (!sessionId) {
      setSessionPlans([]);
      return;
    }
    let cancelled = false;
    void IpcClient.getInstance()
      .listPlanArtifactsForSession(sessionId)
      .then((rows) => {
        if (!cancelled) setSessionPlans(rows);
      })
      .catch(() => {
        if (!cancelled) setSessionPlans([]);
      });
    return () => {
      cancelled = true;
    };
    // planStatus/planId are in the deps so a new plan or a status change refreshes
    // the list without polling.
  }, [panel.sessionId, panel.planId, panel.planStatus]);

  // Plans from this folder's OTHER sessions: a plan outlives the session it was
  // written in (closed, or written in the CLI). Reachable from the switcher and
  // built here through "Use in this session".
  useEffect(() => {
    if (workspaceId == null) {
      setEarlierPlans([]);
      return;
    }
    let cancelled = false;
    void IpcClient.getInstance()
      .listPlanArtifactsForWorkspace(workspaceId, activeSessionId ?? undefined)
      .then((rows) => {
        if (!cancelled) setEarlierPlans(rows);
      })
      .catch(() => {
        if (!cancelled) setEarlierPlans([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, activeSessionId, panel.planId]);

  /** Showing a plan from an earlier session (it can't be built from here as-is). */
  const fromEarlierSession =
    panel.planId != null &&
    activeSessionId != null &&
    panel.sessionId != null &&
    panel.sessionId !== activeSessionId;

  const selectPlan = useCallback(
    async (planId: string) => {
      // "" is the Latest option: unpin and let activation drive the panel again.
      if (!planId) {
        setPanel((prev) => ({ ...prev, pinnedPlanId: null }));
        return;
      }
      const row = await IpcClient.getInstance().getPlanArtifact(planId);
      if (!row) return;
      setPanel((prev) => ({
        ...prev,
        planId: row.planId,
        content: row.content,
        planStatus: row.planStatus,
        sessionId: row.sessionId,
        title: row.title,
        // Pin it, or the next plan-artifact activation would switch away from
        // the plan the user just chose to look at.
        pinnedPlanId: row.planId,
      }));
    },
    [setPanel],
  );

  const adoptPlanHere = useCallback(async () => {
    if (!panel.planId || !activeSessionId) return;
    const copy = await IpcClient.getInstance().copyPlanArtifactToSession(
      panel.planId,
      activeSessionId,
    );
    setPanel((prev) => ({
      ...prev,
      planId: copy.planId,
      content: copy.content,
      planStatus: copy.planStatus,
      sessionId: copy.sessionId,
      title: copy.title,
      pinnedPlanId: copy.planId,
    }));
  }, [panel.planId, activeSessionId, setPanel]);

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

  // While building, local edits the user hasn't saved yet aren't visible to the
  // agent until they Save (then the agent re-reads the plan on its next step).
  const dirtySinceBuild =
    panel.planStatus === "building" &&
    draft.trim() !== (panel.content ?? "").trim();

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
        prompt: BUILD_FROM_PLAN_PROMPT,
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
              {/*
                Name the plan, not just its state — and let the user move between
                them. The panel used to head the single last-activated (i.e.
                newest) plan with the bare word "Plan"/"Building"/"Built", so a
                session with three plans presented one as though it were THE
                plan. The title says which; the switcher below reaches the others.
              */}
              <span className="flex items-center gap-2 min-w-0">
                <StatusHeaderIcon status={panel.planStatus} />
                {panel.planId ? (
                  <span className="flex items-baseline gap-2 min-w-0">
                    <span className="truncate" title={panel.title ?? undefined}>
                      {panel.title?.trim() ||
                        planArtifactTitleFromContent(panel.content ?? "")}
                    </span>
                    <span className="text-xs text-muted-foreground font-normal shrink-0">
                      {statusLabel(panel.planStatus)}
                    </span>
                  </span>
                ) : (
                  "Plan"
                )}
              </span>
              {panel.planStatus === "building" ? (
                <span className="text-xs text-primary font-normal flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  Live
                </span>
              ) : null}
            </div>
            {sessionPlans.length > 1 || earlierPlans.length > 0 ? (
              <div className="px-3 py-2 border-b border-border flex items-center gap-2">
                <label
                  htmlFor="plan-switcher"
                  className="text-xs text-muted-foreground shrink-0"
                >
                  Showing
                </label>
                <select
                  id="plan-switcher"
                  data-testid="plan-switcher"
                  className="flex-1 min-w-0 text-xs bg-muted/30 border border-border rounded-md px-2 py-1"
                  value={panel.pinnedPlanId ?? ""}
                  onChange={(e) => void selectPlan(e.target.value)}
                >
                  <option value="">Latest ({sessionPlans.length} plans)</option>
                  {sessionPlans.map((p) => (
                    <option key={p.planId} value={p.planId}>
                      {(p.title?.trim() ||
                        planArtifactTitleFromContent(p.content ?? "")) +
                        ` — ${statusLabel(p.planStatus)}`}
                    </option>
                  ))}
                  {earlierPlans.length > 0 ? (
                    <optgroup label="Earlier sessions">
                      {earlierPlans.map((p) => (
                        <option key={p.planId} value={p.planId}>
                          {(p.title?.trim() ||
                            planArtifactTitleFromContent(p.content ?? "")) +
                            ` — ${p.sessionTitle?.trim() || "untitled session"}`}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                </select>
              </div>
            ) : null}
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
                  {dirtySinceBuild ? (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      Unsaved edits — click Save so the agent picks them up on
                      its next step.
                    </p>
                  ) : null}
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
                    {fromEarlierSession ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="default"
                        className="gap-1"
                        data-testid="plan-use-here"
                        onClick={() => void adoptPlanHere()}
                      >
                        <ClipboardList className="h-3.5 w-3.5" aria-hidden />
                        Use in this session
                      </Button>
                    ) : null}
                    {panel.planStatus === "plan" && !fromEarlierSession ? (
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
                  </div>
                  {draft.trim() ? (
                    <div
                      className={cn(
                        CHAT_MESSAGE_MARKDOWN_PROSE,
                        "text-sm max-w-none opacity-90 border-t pt-3",
                      )}
                    >
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {draft}
                      </ReactMarkdown>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No plan selected. Click a plan card in chat to open it here,
                  or ask the agent in Plan mode to draft one.
                </p>
              )}
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
