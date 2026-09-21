import { useCallback } from "react";
import { ChatConfigDropdown } from "./ChatConfigDropdown";
import { ChatIntentSelector } from "./ChatIntentSelector";
import { useSettings } from "@/hooks/useSettings";
import { useContextTokenCount } from "@/hooks/useCountTokens";
import { useContextReport } from "@/hooks/useContextReport";
import { useAtomValue } from "jotai";
import {
  pendingWorkspaceAppIdAtom,
  selectedAppIdAtom,
  selectedWorkspaceInfoAtom,
} from "@/atoms/appAtoms";
import {
  getChatBoundAppId,
  resolveChatWorkspaceAppId,
} from "@/lib/chat-workspace-binding";
import { openWorkspaceFromDialog } from "@/lib/open-workspace";
import { toast } from "sonner";
import {
  chatMessagesByIdAtom,
  selectedChatIdAtom,
  liveTurnUsageByChatIdAtom,
  isStreamingByIdAtom,
  turnWorkModeByChatIdAtom,
} from "@/atoms/chatAtoms";
import { activeSessionWorkModeAtom } from "@/atoms/sessionAtoms";
import { NoWorkspaceBanner } from "./chat/NoWorkspaceBanner";
import { ModelPicker } from "./ModelPicker";
import type { WorkMode } from "@/lib/schemas";
import {
  labelForWorkMode,
  resolveSelectedWorkMode,
  resolveDisplayedWorkMode,
} from "@/lib/work-mode";
import { TokenCircle } from "./chat/TokenCircle";
import { useCompactionTokenVisuals } from "@/hooks/useCompactionTokenVisuals";
import { selectionUsesCompass } from "@/hooks/useCompassSendGate";
import { useCreditBalance } from "@/hooks/useCreditBalance";
import { useLoadApps } from "@/hooks/useLoadApps";
import { useTranslation } from "react-i18next";
import { Coachmark } from "@/components/ui/coachmark";
import { useByokModelHint } from "@/hooks/useByokModelHint";
import { useGuidedTour } from "@/hooks/useGuidedTour";
import { GUIDED_TOUR_STEPS, chordForStep } from "@/lib/onboarding/guided-tour";
function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function ChatInputControls({ chatId }: { chatId?: number }) {
  const appId = useAtomValue(selectedAppIdAtom);
  const pendingWorkspaceAppId = useAtomValue(pendingWorkspaceAppIdAtom);
  const selectedWorkspaceInfo = useAtomValue(selectedWorkspaceInfoAtom);
  const { apps, refreshApps } = useLoadApps();
  const selectedChatId = useAtomValue(selectedChatIdAtom);
  const messagesByChatId = useAtomValue(chatMessagesByIdAtom);
  const threadChatId = chatId ?? selectedChatId;
  const threadMessages =
    threadChatId != null ? messagesByChatId.get(threadChatId) : undefined;
  const hasUserMessageInThread =
    threadMessages?.some((m) => m.role === "user") ?? false;
  const { settings } = useSettings();
  // PASS8 E3: Shared context-only token count (dedup'd via React Query key).
  const { result: tokenResult } = useContextTokenCount(chatId ?? null);
  // v14.6 (Bug 1): prefer the model-facing dispatched size (Feed B) — the same
  // source the floating pill uses — so the footer DROPS immediately after a
  // compress_context instead of staying at the stale pre-compaction count until
  // stream end (Feed A / count-tokens is only invalidated at stream end).
  const contextReport = useContextReport(chatId ?? null);
  const { pulse, flashSuccess } = useCompactionTokenVisuals(chatId ?? null);
  const creditBalance = useCreditBalance();
  const { t: tOnboarding } = useTranslation("onboarding");
  const { showByokHint, dismissByokHint, changeModelChord } =
    useByokModelHint();
  const tour = useGuidedTour();
  /*
   * The guided tour OUTRANKS the standalone BYOK hint on this anchor. Both point at
   * the same control, and two coachmarks on one anchor would fight over the popover;
   * the tour is the explicit, user-started thing, so it wins and the BYOK hint waits
   * for a later session.
   */
  const modelTourActive = tour.isStepActive("model");
  const workModeChord = chordForStep(GUIDED_TOUR_STEPS[0]);

  // ONE shared rule with the picker beside it (`resolveSelectedWorkMode`). This used
  // to resolve the global preference ALONE — left behind when sessions gained their
  // own mode in v14.36.0 — so the footer and the picker could name different modes
  // with nothing to say which was in force.
  const sessionWorkMode = useAtomValue(activeSessionWorkModeAtom);
  const selectedWorkMode: WorkMode = resolveSelectedWorkMode({
    sessionWorkMode,
    workModePreference: settings?.workModePreference,
    selectedChatMode: settings?.selectedChatMode,
  });

  // While a turn is live the footer names the mode that turn is RUNNING in, which is
  // fixed at dispatch and cannot be retargeted mid-flight. The picker goes on showing
  // the selected mode (tagged "next turn" when they differ), so both statements on
  // screen are true at the same time instead of contradicting each other.
  const isStreamingById = useAtomValue(isStreamingByIdAtom);
  const turnWorkModeByChatId = useAtomValue(turnWorkModeByChatIdAtom);
  const isStreamingHere =
    threadChatId != null && isStreamingById.get(threadChatId) === true;
  const runningWorkMode =
    isStreamingHere && threadChatId != null
      ? turnWorkModeByChatId.get(threadChatId)
      : undefined;

  const workMode: WorkMode = resolveDisplayedWorkMode({
    selected: selectedWorkMode,
    runningWorkMode,
  });
  const workLabel = labelForWorkMode(workMode);

  const boundAppId =
    threadChatId != null ? getChatBoundAppId(threadChatId) : null;
  const activeInChatId = resolveChatWorkspaceAppId(threadChatId ?? null);

  let contextLine =
    activeInChatId == null ? `${workLabel} · No workspace` : workLabel;

  if (
    pendingWorkspaceAppId != null &&
    pendingWorkspaceAppId !== activeInChatId
  ) {
    const pendingName =
      selectedWorkspaceInfo?.id === pendingWorkspaceAppId
        ? selectedWorkspaceInfo.name
        : (apps.find((a) => a.id === pendingWorkspaceAppId)?.name ??
          "Workspace");
    contextLine = `${contextLine} · ${pendingName} ready for next chat`;
  } else if (activeInChatId != null && boundAppId === activeInChatId) {
    const wsName =
      selectedWorkspaceInfo?.id === activeInChatId
        ? selectedWorkspaceInfo.name
        : apps.find((a) => a.id === activeInChatId)?.name;
    if (wsName) {
      contextLine = `${contextLine} · ${wsName}`;
    }
  }

  let tokenWarning: string | null = null;
  // Prefer live provider usage while a turn streams (same source as TokenBar) so
  // BOTH counters grow live together instead of this one staying on the frozen
  // dispatch estimate.
  const liveUsageByChat = useAtomValue(liveTurnUsageByChatIdAtom);
  const liveUsage = chatId != null ? liveUsageByChat[chatId] : undefined;
  const estimateUsed =
    contextReport?.dispatchedTokens ?? tokenResult?.estimatedTotalTokens ?? 0;
  const usedTokens =
    liveUsage != null
      ? (liveUsage.input ?? estimateUsed) + liveUsage.output
      : estimateUsed;
  const budgetTokens =
    contextReport?.contextWindow ??
    tokenResult?.effectiveBudget ??
    tokenResult?.contextWindow ??
    0;
  const contextPercent =
    budgetTokens > 0 ? Math.min(100, (usedTokens / budgetTokens) * 100) : 0;
  const delegationBudget =
    settings?.aiConfiguration?.delegation?.tokenBudgetPerTurn ??
    settings?.aiConfiguration?.autonomous?.tokenBudgetPerTurn;
  if (delegationBudget && chatId && tokenResult && budgetTokens > 0) {
    if (contextPercent >= 100) tokenWarning = "Token limit reached";
    else if (contextPercent >= 80) tokenWarning = "Approaching token limit";
  }

  const usesCore = selectionUsesCompass(settings?.selectedModel);
  const coreCreditLabel =
    usesCore && !creditBalance.loading && creditBalance.balanceCents != null
      ? `$${(creditBalance.balanceCents / 100).toFixed(2)}`
      : null;

  const handleOpenWorkspace = useCallback(async () => {
    try {
      await openWorkspaceFromDialog({
        apps,
        refreshApps,
        activeChatId: threadChatId,
        hasUserMessageInThread,
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      console.error("Open workspace failed:", error);
      if (msg.includes("Workspace limit") || msg.includes("Upgrade")) {
        alert(msg);
      } else {
        toast.error(`Could not add workspace: ${msg}`);
      }
    }
  }, [apps, refreshApps, threadChatId, hasUserMessageInThread]);

  return (
    <div className="flex flex-col gap-1">
      {!appId && !hasUserMessageInThread && (
        <NoWorkspaceBanner
          className="mb-1"
          onOpenWorkspace={handleOpenWorkspace}
        />
      )}

      {/* Compact context line + non-clickable context usage bar */}
      <div
        className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-0.5 text-xs text-muted-foreground"
        data-testid="active-context-bar"
      >
        <span>{contextLine}</span>
        {tokenWarning && (
          <span
            className="text-amber-600 dark:text-amber-400"
            title={tokenWarning}
          >
            ({tokenWarning})
          </span>
        )}
        {coreCreditLabel && (
          <span
            className="tabular-nums text-[10px] text-muted-foreground/90 shrink-0"
            title="Atlarix Core credit balance"
          >
            Core: {coreCreditLabel}
          </span>
        )}
        {chatId != null && budgetTokens > 0 && tokenResult && (
          <div
            className="flex items-center gap-1.5 shrink-0"
            title={`Context: ${usedTokens.toLocaleString()} / ${formatTokens(budgetTokens)} (${contextPercent.toFixed(0)}%)`}
          >
            <TokenCircle
              used={usedTokens}
              total={budgetTokens}
              size={20}
              pulse={pulse}
              flashSuccess={flashSuccess}
              spin={isStreamingHere}
            />
            {/* A percentage, matching TokenBar. This showed the raw count, and
                once the meter started counting the tool surface honestly an
                untouched chat read "10,864 / 200K" — accurate, and alarming for
                no reason. The exact figures stay in the `title` above and in the
                TokenBar card. */}
            <span className="tabular-nums text-[10px] text-muted-foreground/90">
              {contextPercent.toFixed(0)}%
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {/*
          THE MODEL CHIP, unconditional.

          It used to be `rightPanelVisible && <CompactModelSearch />` — the same
          control, hidden in the layout state most people are in. That is the
          shape of bug worth naming: a surface that exists in one layout and
          vanishes in another teaches people it does not exist at all.
        */}
        <Coachmark
          open={modelTourActive || showByokHint}
          onDismiss={modelTourActive ? tour.end : dismissByokHint}
          title={tOnboarding(
            modelTourActive ? "tour.model.title" : "byokModel.title",
          )}
          body={tOnboarding(
            modelTourActive ? "tour.model.body" : "byokModel.body",
          )}
          keys={changeModelChord}
          actionLabel={tOnboarding("byokModel.action")}
          stepIndex={
            modelTourActive ? (tour.stepIndex ?? undefined) : undefined
          }
          stepCount={modelTourActive ? tour.stepCount : undefined}
          onNext={modelTourActive ? tour.next : undefined}
          nextLabel={tOnboarding("tour.next")}
          skipLabel={tOnboarding("tour.skip")}
          side="top"
          align="end"
          data-testid="byok-model-coachmark"
        >
          <span className="inline-flex" data-tour="tour-model-picker">
            <ModelPicker
              resetKey={threadChatId}
              onOpened={() => {
                // Opening the picker IS completing the tour step, and it is the
                // hint's whole ask — both would otherwise paint underneath the
                // popover they are pointing at.
                dismissByokHint();
                if (modelTourActive) tour.next();
              }}
            />
          </span>
        </Coachmark>

        <ChatConfigDropdown />

        <Coachmark
          open={tour.isStepActive("workModes")}
          onDismiss={tour.end}
          title={tOnboarding("tour.workModes.title")}
          body={tOnboarding("tour.workModes.body")}
          keys={workModeChord}
          actionLabel={tOnboarding("tour.done")}
          stepIndex={tour.stepIndex ?? undefined}
          stepCount={tour.stepCount}
          onNext={tour.next}
          nextLabel={tOnboarding("tour.next")}
          skipLabel={tOnboarding("tour.skip")}
          side="top"
          align="end"
          data-testid="work-modes-coachmark"
        >
          <span className="inline-flex" data-tour="tour-ask-build">
            <ChatIntentSelector />
          </span>
        </Coachmark>
      </div>
    </div>
  );
}
