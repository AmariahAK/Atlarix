import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { ThemeProvider, useTheme } from "../contexts/ThemeContext";
import { DeepLinkProvider } from "../contexts/DeepLinkContext";
import { Toaster } from "sonner";
import { TitleBar } from "./TitleBar";
import { useEffect, useCallback, type ReactNode } from "react";
import { useRunApp } from "@/hooks/useRunApp";
import { useAtomValue, useSetAtom, useAtom } from "jotai";
import { previewModeAtom, selectedAppIdAtom, currentAppAtom } from "@/atoms/appAtoms";
import { useSettings } from "@/hooks/useSettings";
import type { ZoomLevel } from "@/lib/schemas";
import { selectedComponentsPreviewAtom } from "@/atoms/previewAtoms";
import { chatInputValueAtom, activeChatIdAtom } from "@/atoms/chatAtoms";
import { useAIPanelListener } from "@/hooks/useAIPanelListener";
import { useLocation } from "@tanstack/react-router";
import { SimpleInlineChat } from "@/components/SimpleInlineChat";
import { RightPanel } from "@/components/RightPanel";
import { LeftPanel } from "@/components/layout/LeftPanel";
import { WorkspaceNotFoundBanner } from "@/components/WorkspaceNotFoundBanner";
import { AnalyticsConsentModal } from "@/components/AnalyticsConsentModal";
import { rightPanelVisibleAtom, leftPanelVisibleAtom, sourceListAtom, selectedSourceAtom, diagramStalenessAtom, diagramStateAtom, pinnedPanelAtom, previewTabAtom } from "@/atoms/sourceAtoms";
import { activeExtensionIdsAtom } from "@/atoms/viewAtoms";
import { usePanelShortcuts } from "@/hooks/usePanelShortcuts";
import { useStreamChat } from "@/hooks/useStreamChat";
import { useLoadApp } from "@/hooks/useLoadApp";
import { ChevronRight, ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { IpcClient } from "@/ipc/ipc_client";
import { OnboardingProgressBar } from "@/components/OnboardingProgressBar";
import { OnboardingTrigger } from "@/components/OnboardingTrigger";

/**
 * PersistentChatContainer
 * =======================
 * Keeps the chat mounted at layout level so it persists across navigation.
 * Hidden when not on home page, but never unmounted.
 */
function PersistentChatContainer() {
  const location = useLocation();
  const [activeChatId, setActiveChatId] = useAtom(activeChatIdAtom);
  const currentApp = useAtomValue(currentAppAtom);
  const rightPanelVisible = useAtomValue(rightPanelVisibleAtom);
  const setRightPanelVisible = useSetAtom(rightPanelVisibleAtom);
  const setPinnedPanel = useSetAtom(pinnedPanelAtom);
  const setPreviewTab = useSetAtom(previewTabAtom);
  const sources = useAtomValue(sourceListAtom);
  const setSourceList = useSetAtom(sourceListAtom);
  const setSelectedSource = useSetAtom(selectedSourceAtom);
  const setDiagramState = useSetAtom(diagramStateAtom);
  const { streamMessage } = useStreamChat({ hasChatId: false });
  const { isDarkMode } = useTheme();

  // Determine if we're on the home page
  const isHomePage = location.pathname === '/';

  // Handle continuing the chat conversation (verify workspace path before send)
  const handleContinueChat = useCallback(async (prompt: string) => {
    if (!activeChatId || !prompt.trim()) return;
    try {
      const chat = await IpcClient.getInstance().getChat(activeChatId);
      if (chat.appId != null) {
        const app = await IpcClient.getInstance().getApp(chat.appId);
        if (app.pathExists === false) {
          const { showError } = await import("@/lib/toast");
          showError("Workspace folder not found. It may have been moved or deleted. Remove it from the list and try again.");
          return;
        }
      }
      streamMessage({
        prompt,
        chatId: activeChatId,
        attachments: [],
      });
    } catch (e) {
      console.error("Continue chat check failed:", e);
      streamMessage({ prompt, chatId: activeChatId, attachments: [] });
    }
  }, [activeChatId, streamMessage]);

  // Handle new chat - reset to home state
  const handleNewChat = useCallback(() => {
    setActiveChatId(null);
    setSourceList([]);
    setSelectedSource(null);
    setRightPanelVisible(false);
    setDiagramState(null); // Clear stale diagram
  }, [setActiveChatId, setSourceList, setSelectedSource, setRightPanelVisible, setDiagramState]);

  // Don't render anything if no active chat
  if (!activeChatId) {
    return null;
  }

  return (
    <div
      className={cn(
        "absolute inset-0 flex flex-col z-10 bg-background",
        // Show when on home page AND has active chat
        !isHomePage && "hidden"
      )}
    >
      {/* Chat header + content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Sticky header with back button and panel toggle */}
        <div className="flex-shrink-0 flex items-center justify-between px-4 py-3 border-b border-border bg-background/95 backdrop-blur-sm">
          <button
            onClick={handleNewChat}
            className="text-xs text-muted-foreground/70 hover:text-foreground flex items-center gap-1 transition-colors"
          >
            ← New Chat
          </button>
          <div className="flex items-center gap-2">
            <span className="font-medium">Atlarix</span>
            {currentApp && (
              <span
                className="text-xs text-muted-foreground font-normal truncate max-w-[180px]"
                title={`Commands run in this workspace. Path: ${currentApp.path}`}
              >
                Workspace: {currentApp.name}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Source count badge – click to open right panel and show Sources tab */}
            {sources.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setPinnedPanel("web-search");
                  setPreviewTab("sources");
                  setRightPanelVisible(true);
                }}
                className="text-xs px-2 py-1 rounded-full bg-primary/10 text-primary hover:bg-primary/20 transition-colors font-medium"
                title="Open panel and show sources"
              >
                {sources.length} sources
              </button>
            )}
            {/* Panel toggle button */}
            <button
              type="button"
              onClick={() => setRightPanelVisible(!rightPanelVisible)}
              className="flex items-center justify-center w-8 h-8 rounded-lg border border-border/60 bg-background/80 text-muted-foreground hover:text-foreground hover:bg-accent hover:border-border transition-colors shrink-0"
              title={rightPanelVisible ? "Hide panel" : "Show panel"}
              aria-label={rightPanelVisible ? "Hide right panel" : "Show right panel"}
            >
              {rightPanelVisible ? (
                <ChevronRight className="w-4 h-4 shrink-0" aria-hidden />
              ) : (
                <ChevronLeft className="w-4 h-4 shrink-0" aria-hidden />
              )}
            </button>
          </div>
        </div>

        {/* Chat messages and input - stays mounted */}
        <SimpleInlineChat
          chatId={activeChatId}
          onSendMessage={handleContinueChat}
        />
      </div>

      {/* Right Panel rendered at layout level for workspace-without-chat case */}
    </div>
  );
}

const DEFAULT_ZOOM_LEVEL: ZoomLevel = "100";

export default function RootLayout({ children }: { children: ReactNode }) {
  // Listen for AI-controlled panel updates from main process
  useAIPanelListener();
  const { refreshAppIframe } = useRunApp();
  const previewMode = useAtomValue(previewModeAtom);
  const { settings } = useSettings();
  const setSelectedComponentsPreview = useSetAtom(
    selectedComponentsPreviewAtom,
  );
  const setChatInput = useSetAtom(chatInputValueAtom);
  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const setSelectedAppId = useSetAtom(selectedAppIdAtom);
  const currentApp = useAtomValue(currentAppAtom);
  const rightPanelVisible = useAtomValue(rightPanelVisibleAtom);
  const setRightPanelVisible = useSetAtom(rightPanelVisibleAtom);
  const leftPanelVisible = useAtomValue(leftPanelVisibleAtom);
  const setLeftPanelVisible = useSetAtom(leftPanelVisibleAtom);
  const activeExtensionIds = useAtomValue(activeExtensionIdsAtom);
  const activeChatId = useAtomValue(activeChatIdAtom);
  const location = useLocation();

  usePanelShortcuts();

  // When user adds first extension, open the left panel
  useEffect(() => {
    if (activeExtensionIds.length > 0 && !leftPanelVisible) {
      setLeftPanelVisible(true);
    }
  }, [activeExtensionIds.length, leftPanelVisible, setLeftPanelVisible]);
  // Home = "/" or "/chat". Show right panel and Diagram|Preview|Code bar on home when workspace or chat is active.
  const isOnChatPage = location.pathname === "/" || location.pathname.startsWith("/chat");
  const showWorkspacePanel = currentApp?.pathExists !== false;

  // Load diagram when workspace is selected (even before first prompt)
  useLoadApp(selectedAppId);

  // Re-check workspace path when loading a chat: sync selectedAppId from chat so useLoadApp refetches and banner shows if path missing
  useEffect(() => {
    if (activeChatId == null) return;
    let cancelled = false;
    (async () => {
      try {
        const chat = await IpcClient.getInstance().getChat(activeChatId);
        if (cancelled || chat.appId == null) return;
        setSelectedAppId(chat.appId);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeChatId, setSelectedAppId]);

  useEffect(() => {
    const zoomLevel = settings?.zoomLevel ?? DEFAULT_ZOOM_LEVEL;
    const zoomFactor = Number(zoomLevel) / 100;

    const electronApi = (
      window as Window & {
        electron?: {
          webFrame?: {
            setZoomFactor: (factor: number) => void;
          };
        };
      }
    ).electron;

    if (electronApi?.webFrame?.setZoomFactor) {
      electronApi.webFrame.setZoomFactor(zoomFactor);

      return () => {
        electronApi.webFrame?.setZoomFactor(Number(DEFAULT_ZOOM_LEVEL) / 100);
      };
    }

    return () => { };
  }, [settings?.zoomLevel]);
  // Global keyboard listener for refresh events
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Check for Ctrl+R (Windows/Linux) or Cmd+R (macOS)
      if (event.key === "r" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault(); // Prevent default browser refresh
        if (previewMode === "preview") {
          refreshAppIframe(); // Use our custom refresh function instead
        }
      }
    };

    // Add event listener to document
    document.addEventListener("keydown", handleKeyDown);

    // Cleanup function to remove event listener
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [refreshAppIframe, previewMode]);

  useEffect(() => {
    setChatInput("");
    setSelectedComponentsPreview([]);
  }, [selectedAppId]);

  // Listen for diagram staleness events from main process
  const setDiagramStaleness = useSetAtom(diagramStalenessAtom);
  useEffect(() => {
    const unsubscribe = IpcClient.getInstance().onDiagramStalenessDetected((data) => {
      setDiagramStaleness({
        diagramId: data.diagramId,
        isStale: data.isStale,
        severity: data.severity as 'none' | 'minor' | 'moderate' | 'major',
        reason: data.reason,
        recommendation: data.recommendation as 'keep' | 'suggest-refresh' | 'force-refresh',
      });
    });
    return () => unsubscribe();
  }, [setDiagramStaleness]);

  return (
    <>
      <AnalyticsConsentModal />
      <ThemeProvider>
        <DeepLinkProvider>
          <OnboardingTrigger />
          <OnboardingProgressBar />
          <SidebarProvider>
            <TitleBar />
            <AppSidebar />
            <div
              id="layout-main-content-container"
              className="relative flex h-screenish w-full overflow-hidden mt-12 mb-4 mr-4 border-t border-l border-border rounded-lg bg-background"
            >
              {leftPanelVisible && <LeftPanel />}
              {/* Top-right panel toggle: always on chat page so panel works for web-only chats too */}
              {isOnChatPage && (
                <button
                  type="button"
                  onClick={() => setRightPanelVisible(!rightPanelVisible)}
                  className="absolute top-2 right-2 z-20 flex items-center justify-center w-9 h-9 rounded-lg border border-border/60 bg-background/80 text-muted-foreground hover:text-foreground hover:bg-accent hover:border-border transition-colors shadow-sm"
                  title={rightPanelVisible ? "Hide panel" : "Show panel"}
                  aria-label={rightPanelVisible ? "Hide right panel" : "Show right panel"}
                >
                  {rightPanelVisible ? (
                    <ChevronRight className="w-4 h-4 shrink-0" aria-hidden />
                  ) : (
                    <ChevronLeft className="w-4 h-4 shrink-0" aria-hidden />
                  )}
                </button>
              )}
              {/* Main content: chat when active, else route content */}
              <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
                {/* Workspace folder missing (deleted outside app) */}
                {isOnChatPage && <WorkspaceNotFoundBanner />}
                {/* Chat overlay when active, else route content */}
                <PersistentChatContainer />
                {!activeChatId && children}
              </div>
              {/* Right panel: on chat page whenever visible (works for workspace and web-only chats) */}
              {rightPanelVisible && isOnChatPage && <RightPanel />}
            </div>
            <Toaster richColors />
          </SidebarProvider>
        </DeepLinkProvider>
      </ThemeProvider>
    </>
  );
}
