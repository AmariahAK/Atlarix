import { useCallback, useState } from "react";
import { ContextFilesPicker } from "./ContextFilesPicker";
import { ModelPickerSheetContent } from "./ModelPickerSheetContent";
import { ChatConfigDropdown } from "./ChatConfigDropdown";
import { ChatIntentSelector } from "./ChatIntentSelector";
import { McpToolsPickerContent } from "@/components/McpToolsPicker";
import { AutoConfigContent } from "@/components/AutoConfigContent";
import { useSettings } from "@/hooks/useSettings";
import { useContextTokenCount } from "@/hooks/useCountTokens";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useAtomValue, useSetAtom } from "jotai";
import { selectedAppIdAtom, selectedWorkspaceInfoAtom } from "@/atoms/appAtoms";
import { chatMessagesByIdAtom, selectedChatIdAtom } from "@/atoms/chatAtoms";
import { rightPanelVisibleAtom } from "@/atoms/sourceAtoms";
import { NoWorkspaceBanner } from "./chat/NoWorkspaceBanner";
import { CompactModelSearch } from "./CompactModelSearch";
import { formatAutoTierLabel, useLastAutoRoutedTier } from "@/hooks/useLastAutoRoutedTier";
import type { WorkMode } from "@/lib/schemas";
import { labelForWorkMode } from "@/lib/work-mode";
import { TokenCircle } from "./chat/TokenCircle";
import { useCompactionTokenVisuals } from "@/hooks/useCompactionTokenVisuals";
import { selectionUsesCompass } from "@/hooks/useCompassSendGate";
import { useCompassUsage } from "@/hooks/useCompassUsage";
import { useLoadApps } from "@/hooks/useLoadApps";
import { IpcClient } from "@/ipc/ipc_client";
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
  const setSelectedAppId = useSetAtom(selectedAppIdAtom);
  const setSelectedWorkspaceInfo = useSetAtom(selectedWorkspaceInfoAtom);
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
  const [configSubView, setConfigSubView] = useState<
    "model" | "mcp" | "auto" | null
  >(null);
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  // PASS8 E3: Shared context-only token count (dedup'd via React Query key).
  const { result: tokenResult } = useContextTokenCount(chatId ?? null);
  const { pulse, flashSuccess } = useCompactionTokenVisuals(chatId ?? null);
  const compassUsage = useCompassUsage();

  const agentMode = settings?.agentMode ?? "guided";
  const effectivePermission =
    settings?.selectedChatMode === "agent"
      ? "build"
      : settings?.selectedChatMode ?? "build";
  const workMode: WorkMode =
    settings?.workModePreference ??
    (effectivePermission === "ask" ? "ask" : "build");
  const workLabel = labelForWorkMode(workMode);

  let contextLine =
    !appId
      ? `${workLabel} · No workspace`
      : `${workLabel} · ${agentMode === "direct" ? "Direct" : agentMode === "guided" ? "Guided" : "Autonomous"}`;

  let tokenWarning: string | null = null;
  const usedTokens = tokenResult?.estimatedTotalTokens ?? 0;
  const budgetTokens = tokenResult?.effectiveBudget ?? tokenResult?.contextWindow ?? 0;
  const contextPercent = budgetTokens > 0 ? Math.min(100, (usedTokens / budgetTokens) * 100) : 0;
  if (agentMode === "autonomous" && chatId && tokenResult && budgetTokens > 0) {
    if (contextPercent >= 100) tokenWarning = "Token limit reached";
    else if (contextPercent >= 80) tokenWarning = "Approaching token limit";
  }

  const isAutoMode =
    settings?.autoModelRouting === true || settings?.selectedModel?.provider === "auto";
  const lastAutoTier = useLastAutoRoutedTier(chatId ?? selectedChatId ?? null);
  const autoTierSuffix = formatAutoTierLabel(lastAutoTier);
  const usesCompassQuotaRow = selectionUsesCompass(
    settings?.selectedModel,
    settings?.autoProviderId ?? undefined,
  );
  const compassQuotaReady =
    usesCompassQuotaRow &&
    !compassUsage.loading &&
    compassUsage.percentRemaining != null &&
    compassUsage.monthlyLimit != null;

  const handleOpenWorkspace = useCallback(async () => {
    try {
      const ipcRenderer = window.electron?.ipcRenderer;
      const result = (await ipcRenderer?.invoke?.("dialog:openDirectory")) as
        | { canceled?: boolean; filePaths?: string[] }
        | undefined;
      if (!result || result.canceled || !result.filePaths?.[0]) return;
      const path = result.filePaths[0];

      const existingApp = apps.find((app) => app.path === path);
      if (existingApp) {
        setSelectedAppId(existingApp.id);
        setSelectedWorkspaceInfo({
          id: existingApp.id,
          name: existingApp.name,
          path: existingApp.path ?? path,
        });
        return;
      }

      if (ipcRenderer?.invoke) {
        const limitCheck = (await ipcRenderer.invoke("auth:check-workspace-limit")) as {
          allowed?: boolean;
          reason?: string;
        };
        if (!limitCheck.allowed) {
          const { triggerUpgrade } = await import("@/hooks/useUpgrade");
          void triggerUpgrade();
          alert(
            `Workspace limit reached. ${limitCheck.reason ?? "Upgrade to Pro for unlimited workspaces."}`,
          );
          return;
        }
      }

      const appName = path.split(/[/\\]/).pop() || "Workspace";
      const importResult = await IpcClient.getInstance().importApp({ path, appName });
      setSelectedAppId(importResult.appId);
      setSelectedWorkspaceInfo({ id: importResult.appId, name: appName, path });
      await refreshApps?.();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      console.error("Open workspace failed:", error);
      alert(`Could not add workspace: ${msg}`);
    }
  }, [apps, refreshApps, setSelectedAppId, setSelectedWorkspaceInfo]);

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
        {isAutoMode && (
          <span
            className="text-[11px] text-muted-foreground shrink-0 max-w-[min(100%,14rem)] sm:max-w-none"
            title="Turn off Auto in the config menu to pick a fixed model."
          >
            {autoTierSuffix ? `Auto · ${autoTierSuffix} tier` : "Auto"}
          </span>
        )}
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
        {rightPanelVisible && !isAutoMode && (
          <CompactModelSearch className="shrink-0" />
        )}
        <Popover
          open={configSubView !== null}
          onOpenChange={(open) => !open && setConfigSubView(null)}
        >
          <PopoverAnchor asChild>
            <span className="inline-flex" data-tour="tour-model-picker">
              <ChatConfigDropdown
                hideManualModelControls={isAutoMode}
                onOpenModelPicker={
                  rightPanelVisible || isAutoMode
                    ? undefined
                    : () => {
                        setConfigSubView(null);
                        setModelSheetOpen(true);
                      }
                }
                onOpenMcpTools={() => setConfigSubView("mcp")}
                onOpenAutoConfig={() => setConfigSubView("auto")}
              />
            </span>
          </PopoverAnchor>
          <PopoverContent
            align="start"
            side="top"
            sideOffset={8}
            avoidCollisions
            collisionPadding={16}
            className="z-200 w-auto max-w-[min(90vw,24rem)] max-h-[min(70vh,var(--radix-popover-content-available-height,70vh))] overflow-y-auto p-0"
          >
            {configSubView === "mcp" && <McpToolsPickerContent appId={appId} />}
            {configSubView === "auto" && <AutoConfigContent />}
          </PopoverContent>
        </Popover>

        {!rightPanelVisible && (
        <Sheet
          open={modelSheetOpen && !isAutoMode}
          onOpenChange={(o) => {
            if (!isAutoMode) setModelSheetOpen(o);
          }}
        >
          <SheetContent
            side="right"
            className="sm:max-w-md overflow-y-auto"
          >
            <SheetHeader>
              <SheetTitle>Change model</SheetTitle>
            </SheetHeader>
            <ModelPickerSheetContent
              onClose={() => setModelSheetOpen(false)}
              disabled={isAutoMode}
            />
          </SheetContent>
        </Sheet>
        )}

        <ChatIntentSelector />

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
