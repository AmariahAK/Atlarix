import { useCallback, useState } from "react";
import { ContextFilesPicker } from "./ContextFilesPicker";
import { ModelPickerSheetContent } from "./ModelPickerSheetContent";
import { ChatConfigDropdown } from "./ChatConfigDropdown";
import { ChatIntentSelector } from "./ChatIntentSelector";
import { useSettings } from "@/hooks/useSettings";
import { useContextTokenCount } from "@/hooks/useCountTokens";
import { useContextReport } from "@/hooks/useContextReport";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useAtomValue } from "jotai";
import {
  pendingWorkspaceAppIdAtom,
  selectedAppIdAtom,
  selectedWorkspaceInfoAtom,
} from "@/atoms/appAtoms";
import { getChatBoundAppId, resolveChatWorkspaceAppId } from "@/lib/chat-workspace-binding";
import { openWorkspaceFromDialog } from "@/lib/open-workspace";
import { toast } from "sonner";
import { chatMessagesByIdAtom, selectedChatIdAtom } from "@/atoms/chatAtoms";
import { rightPanelVisibleAtom } from "@/atoms/sourceAtoms";
import { NoWorkspaceBanner } from "./chat/NoWorkspaceBanner";
import { CompactModelSearch } from "./CompactModelSearch";
import type { WorkMode } from "@/lib/schemas";
import { labelForWorkMode } from "@/lib/work-mode";
import { TokenCircle } from "./chat/TokenCircle";
import { useCompactionTokenVisuals } from "@/hooks/useCompactionTokenVisuals";
import { selectionUsesCompass } from "@/hooks/useCompassSendGate";
import { useCompassUsage } from "@/hooks/useCompassUsage";
import { useLoadApps } from "@/hooks/useLoadApps";
function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function ChatInputControls({
  showContextFilesPicker = false,
  chatId,
}: {
  showContextFilesPicker?: boolean;
  chatId?: number;
}) {
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
  const rightPanelVisible = useAtomValue(rightPanelVisibleAtom);
  const { settings } = useSettings();
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  // PASS8 E3: Shared context-only token count (dedup'd via React Query key).
  const { result: tokenResult } = useContextTokenCount(chatId ?? null);
  // v14.6 (Bug 1): prefer the model-facing dispatched size (Feed B) — the same
  // source the floating pill uses — so the footer DROPS immediately after a
  // compress_context instead of staying at the stale pre-compaction count until
  // stream end (Feed A / count-tokens is only invalidated at stream end).
  const contextReport = useContextReport(chatId ?? null);
  const { pulse, flashSuccess } = useCompactionTokenVisuals(chatId ?? null);
  const compassUsage = useCompassUsage();

  const effectivePermission =
    settings?.selectedChatMode === "agent"
      ? "build"
      : settings?.selectedChatMode ?? "build";
  const workMode: WorkMode =
    settings?.workModePreference ??
    (effectivePermission === "ask" ? "ask" : "build");
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
        : apps.find((a) => a.id === pendingWorkspaceAppId)?.name ?? "Workspace";
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
  const usedTokens =
    contextReport?.dispatchedTokens ?? tokenResult?.estimatedTotalTokens ?? 0;
  const budgetTokens =
    contextReport?.contextWindow ??
    tokenResult?.effectiveBudget ??
    tokenResult?.contextWindow ??
    0;
  const contextPercent = budgetTokens > 0 ? Math.min(100, (usedTokens / budgetTokens) * 100) : 0;
  const delegationBudget =
    settings?.aiConfiguration?.delegation?.tokenBudgetPerTurn ??
    settings?.aiConfiguration?.autonomous?.tokenBudgetPerTurn;
  if (delegationBudget && chatId && tokenResult && budgetTokens > 0) {
    if (contextPercent >= 100) tokenWarning = "Token limit reached";
    else if (contextPercent >= 80) tokenWarning = "Approaching token limit";
  }

  const usesCompassQuotaRow = selectionUsesCompass(settings?.selectedModel);
  const compassQuotaReady =
    usesCompassQuotaRow &&
    !compassUsage.loading &&
    compassUsage.percentRemaining != null &&
    compassUsage.monthlyLimit != null;

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
        <NoWorkspaceBanner className="mb-1" onOpenWorkspace={handleOpenWorkspace} />
      )}

      {/* Compact context line + non-clickable context usage bar */}
      <div
        className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-0.5 text-xs text-muted-foreground"
        data-testid="active-context-bar"
      >
        <span>{contextLine}</span>
        {tokenWarning && (
          <span className="text-amber-600 dark:text-amber-400" title={tokenWarning}>
            ({tokenWarning})
          </span>
        )}
        {chatId != null && budgetTokens > 0 && tokenResult && !compassQuotaReady && (
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
            />
            <span className="tabular-nums text-[10px] text-muted-foreground/90">
              {usedTokens.toLocaleString()} / {formatTokens(budgetTokens)}
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {rightPanelVisible && (
          <CompactModelSearch className="shrink-0" />
        )}
        <span className="inline-flex" data-tour="tour-model-picker">
          <ChatConfigDropdown
            onOpenModelPicker={
              rightPanelVisible
                ? undefined
                : () => setModelSheetOpen(true)
            }
          />
        </span>

        {!rightPanelVisible && (
        <Sheet
          open={modelSheetOpen}
          onOpenChange={setModelSheetOpen}
        >
          <SheetContent
            side="right"
            className="sm:max-w-md overflow-y-auto"
          >
            <SheetHeader>
              <SheetTitle>Change model</SheetTitle>
            </SheetHeader>
            <ModelPickerSheetContent onClose={() => setModelSheetOpen(false)} />
          </SheetContent>
        </Sheet>
        )}

        <span className="inline-flex" data-tour="tour-ask-build">
          <ChatIntentSelector />
        </span>

        {showContextFilesPicker && (
          <>
            <div className="w-1" />
            <ContextFilesPicker />
          </>
        )}
      </div>
    </div>
  );
}
