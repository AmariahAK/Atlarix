import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { ThemeProvider, useTheme } from "../contexts/ThemeContext";
import { DeepLinkProvider } from "../contexts/DeepLinkContext";
import { Toaster, toast } from "sonner";
import { TitleBar } from "./TitleBar";
import { useEffect, useCallback, useRef, type ReactNode } from "react";
import { useRunApp } from "@/hooks/useRunApp";
import { useAtomValue, useSetAtom, useAtom, getDefaultStore } from "jotai";
import {
  previewModeAtom,
  selectedAppIdAtom,
  pendingWorkspaceAppIdAtom,
  selectedWorkspaceInfoAtom,
  appsListAtom,
  currentAppAtom,
  userSettingsAtom,
} from "@/atoms/appAtoms";
import { useSettings } from "@/hooks/useSettings";
import type { ZoomLevel } from "@/lib/schemas";
import { selectedComponentsPreviewAtom } from "@/atoms/previewAtoms";
import { chatInputValueAtom, activeChatIdAtom, selectedChatIdAtom } from "@/atoms/chatAtoms";
import { useNavigate } from "@tanstack/react-router";
import { useAIPanelListener } from "@/hooks/useAIPanelListener";
import { useLocation } from "@tanstack/react-router";
import { SimpleInlineChat } from "@/components/SimpleInlineChat";
import { RightPanel } from "@/components/RightPanel";
import { LeftPanel } from "@/components/layout/LeftPanel";
import { WorkspaceNotFoundBanner } from "@/components/WorkspaceNotFoundBanner";
import { PendingInviteBanner } from "@/components/PendingInviteBanner";
import { UpdateBanner } from "@/components/UpdateBanner";
import { AnalyticsConsentModal } from "@/components/AnalyticsConsentModal";
import {
  rightPanelVisibleAtom,
  leftPanelVisibleAtom,
  sourceListAtom,
  selectedSourceAtom,
  diagramStalenessAtom,
  diagramStateAtom,
  rightPanelSuppressAutoOpenAtom,
  pinnedPanelAtom,
  previewTabAtom,
} from "@/atoms/sourceAtoms";
import { activeExtensionIdsAtom, onboardingStepAtom } from "@/atoms/viewAtoms";
import { usePanelShortcuts } from "@/hooks/usePanelShortcuts";
import { useStreamChat } from "@/hooks/useStreamChat";
import { useAuth } from "@/lib/auth/useAuth";
import { showError } from "@/lib/toast";
import { useLoadApp } from "@/hooks/useLoadApp";
import { ChevronRight, ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { IpcClient } from "@/ipc/ipc_client";
import { subscribeAutoSelfCorrect } from "@/lib/renderer-ipc-bridge";
import { preloadSounds } from "@/lib/sounds";
import { OnboardingProgressBar } from "@/components/OnboardingProgressBar";
import { OnboardingTrigger } from "@/components/OnboardingTrigger";
import { TourManager } from "@/components/tour/TourManager";
import { CommunityDialog } from "@/components/CommunityDialog";
import { useRightPanelUserPreference } from "@/hooks/useRightPanelUserPreference";
import type { FileAttachment } from "@/ipc/ipc_types";
import { startNewWorkspaceConversation } from "@/lib/open-workspace-session";

/**
 * PersistentChatContainer
 * =======================
 * Keeps the chat mounted at layout level so it persists across navigation.
 * Hidden when not on home page, but never unmounted.
 */
function PersistentChatContainer() {
  const location = useLocation();
  const navigate = useNavigate();
  const [activeChatId, setActiveChatId] = useAtom(activeChatIdAtom);
  const currentApp = useAtomValue(currentAppAtom);
  const { visible: rightPanelVisible, toggle: toggleRightPanel, show: showRightPanel } =
    useRightPanelUserPreference();
  const setRightPanelVisible = useSetAtom(rightPanelVisibleAtom);
  const setSuppressAutoOpen = useSetAtom(rightPanelSuppressAutoOpenAtom);
  const setPinnedPanel = useSetAtom(pinnedPanelAtom);
  const setPreviewTab = useSetAtom(previewTabAtom);
  const sources = useAtomValue(sourceListAtom);
  const setSourceList = useSetAtom(sourceListAtom);
  const setSelectedSource = useSetAtom(selectedSourceAtom);
  const setDiagramState = useSetAtom(diagramStateAtom);
  const { streamMessage } = useStreamChat({ hasChatId: false });
  const { isDarkMode } = useTheme();
  const { isAuthenticated, loading: authLoading } = useAuth();
  const pendingWorkspaceAppId = useAtomValue(pendingWorkspaceAppIdAtom);
  const setPendingWorkspaceAppId = useSetAtom(pendingWorkspaceAppIdAtom);
  const appsList = useAtomValue(appsListAtom);
  const mustSignIn = !authLoading && !isAuthenticated;
  const setSelectedAppId = useSetAtom(selectedAppIdAtom);
  const selectedAppId = useAtomValue(selectedAppIdAtom);

  // Determine if we're on the home page
  const isHomePage = location.pathname === '/';

  // Handle continuing the chat conversation (verify workspace path before send)
  const handleContinueChat = useCallback(async (prompt: string, attachments?: FileAttachment[]) => {
    if (!activeChatId || (!prompt.trim() && (attachments?.length ?? 0) === 0)) return;
    if (mustSignIn) {
      showError("Please sign in to use chat.");
      return;
    }
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
        attachments: attachments ?? [],
      });
    } catch (e) {
      console.error("Continue chat check failed:", e);
      streamMessage({ prompt, chatId: activeChatId, attachments: attachments ?? [] });
    }
  }, [activeChatId, streamMessage, mustSignIn]);

  const handleNewChat = useCallback(() => {
    const workspaceId = selectedAppId ?? pendingWorkspaceAppId;
    if (workspaceId != null) {
      const app = appsList.find((a) => a.id === workspaceId);
      void startNewWorkspaceConversation({
        workspaceId,
        workspaceName: app?.name,
        workspacePath: app?.path,
        navigate: (opts) => navigate(opts),
      }).then((chatId) => {
        if (chatId != null) {
          setSourceList([]);
          setSelectedSource(null);
          setSuppressAutoOpen(true);
          setPendingWorkspaceAppId(null);
        }
      });
      return;
    }
    setActiveChatId(null);
    setSourceList([]);
    setSelectedSource(null);
    setSuppressAutoOpen(true);
    setSelectedAppId(null);
  }, [
    selectedAppId,
    pendingWorkspaceAppId,
    appsList,
    navigate,
    setActiveChatId,
    setSourceList,
    setSelectedSource,
    setSuppressAutoOpen,
    setSelectedAppId,
    setPendingWorkspaceAppId,
  ]);

  if (!activeChatId || selectedAppId == null) {
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
      {/* PASS8 H1: `min-h-0` on the inner column so SimpleInlineChat's scroll
          area can shrink as the composer grows; without it, last messages get
          clipped under the input when attachments/multiline expand the
          composer. */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
        {/* Sticky header with back button and panel toggle */}
        <div className="flex-shrink-0 flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-border bg-background/95 backdrop-blur-sm">
          <button
            onClick={handleNewChat}
            className="text-xs text-muted-foreground/70 hover:text-foreground flex items-center gap-1 transition-colors"
          >
            ← New chat
          </button>
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-medium">Atlarix</span>
            {currentApp && (
              <span
                className="text-xs text-muted-foreground font-normal truncate max-w-[220px] inline-flex items-center gap-1.5 min-w-0"
                title={`Commands run in this workspace. Path: ${currentApp.path}`}
              >
                <span className="truncate">Workspace: {currentApp.name}</span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {sources.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setPinnedPanel("web-search");
                  setPreviewTab("sources");
                  showRightPanel();
                }}
                className="text-xs px-2 py-1 rounded-full bg-primary/10 text-primary hover:bg-primary/20 transition-colors font-medium"
                title="Open panel and show sources"
              >
                {sources.length} sources
              </button>
            )}
            <button
              type="button"
              onClick={toggleRightPanel}
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
  const { streamMessage } = useStreamChat({ hasChatId: false });
  const streamMessageRef = useRef(streamMessage);
  streamMessageRef.current = streamMessage;
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
  const setSelectedWorkspaceInfo = useSetAtom(selectedWorkspaceInfoAtom);
  const setSelectedChatId = useSetAtom(selectedChatIdAtom);
  const setActiveChatId = useSetAtom(activeChatIdAtom);
  const navigate = useNavigate();
  const currentApp = useAtomValue(currentAppAtom);
  const { visible: rightPanelVisible, toggle: toggleRightPanel } = useRightPanelUserPreference();
  const leftPanelVisible = useAtomValue(leftPanelVisibleAtom);
  const setLeftPanelVisible = useSetAtom(leftPanelVisibleAtom);
  const activeExtensionIds = useAtomValue(activeExtensionIdsAtom);
  const activeChatId = useAtomValue(activeChatIdAtom);
  const location = useLocation();
  const onboardingStep = useAtomValue(onboardingStepAtom);

  /** Home chat UI covers the outlet only on `/` or `/chat`; other routes (e.g. `/account`, `/settings`) must always render. */
  const suppressOutletForHomeChat =
    activeChatId != null &&
    (location.pathname === "/" || location.pathname.startsWith("/chat"));

  usePanelShortcuts();

  useEffect(() => {
    preloadSounds();
  }, []);

  // When user adds first extension, open the left panel
  useEffect(() => {
    if (activeExtensionIds.length > 0 && !leftPanelVisible) {
      setLeftPanelVisible(true);
    }
  }, [activeExtensionIds.length, leftPanelVisible, setLeftPanelVisible]);
  // Home = "/" or "/chat". Show right panel and Diagram|Preview|Code bar on home when workspace or chat is active.
  const isOnChatPage = location.pathname === "/" || location.pathname.startsWith("/chat");
  const showWorkspaceChrome = selectedAppId != null;
  const showWorkspacePanel = currentApp?.pathExists !== false;

  // Load diagram when workspace is selected (even before first prompt)
  useLoadApp(selectedAppId);

  useEffect(() => {
    const unsub = IpcClient.getInstance().onWorkspaceOpenedFromCli(
      ({ appId, chatId, path }) => {
        setSelectedAppId(appId);
        setSelectedChatId(chatId);
        setActiveChatId(chatId);
        navigate({ to: "/" });
        toast.success(`Opened workspace: ${path}`);
      },
    );
    return unsub;
  }, [navigate, setSelectedAppId, setSelectedChatId, setActiveChatId]);

  // Re-check workspace path when loading a chat: sync selectedAppId from chat so useLoadApp refetches and banner shows if path missing
  useEffect(() => {
    if (activeChatId == null) return;
    let cancelled = false;
    (async () => {
      try {
        const chat = await IpcClient.getInstance().getChat(activeChatId);
        if (cancelled || chat.appId == null) return;
        setSelectedAppId(chat.appId);
        try {
          const app = await IpcClient.getInstance().getApp(chat.appId);
          if (!cancelled && app.path) {
            setSelectedWorkspaceInfo({
              id: app.id,
              name: app.name,
              path: app.path,
            });
          }
        } catch {
          /* path sync best-effort */
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeChatId, setSelectedAppId, setSelectedWorkspaceInfo]);

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

  // Fix: Finding 4 — models.dev background refresh (non-blocking notice)
  useEffect(() => {
    const unsub = IpcClient.getInstance().onModelsDevStatus(({ message, timedOut }) => {
      if (!message?.trim()) return;
      toast.message(message, { duration: timedOut ? 10_000 : 5_000 });
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    return subscribeAutoSelfCorrect(({ chatId }) => {
      void streamMessageRef.current({
        prompt: "",
        chatId,
        continueAfterQuestions: true,
        attachments: [],
      });
    });
  }, []);

  useEffect(() => {
    const unsub = IpcClient.getInstance().onModeChanged(({ settings }) => {
      getDefaultStore().set(userSettingsAtom, settings);
    });
    return () => unsub();
  }, []);

  const showOnboardingHighlight =
    onboardingStep != null && onboardingStep >= 2 && onboardingStep <= 5;

  return (
    <>
      <AnalyticsConsentModal />
      <ThemeProvider>
        <DeepLinkProvider>
          <OnboardingTrigger />
          <TourManager />
          <CommunityDialog />
          <OnboardingProgressBar />
          {showOnboardingHighlight && (
            <style>{`
              [data-onboarding-step="2"] [data-onboarding="welcome-open-folder"],
              [data-onboarding-step="3"] [data-onboarding="settings-link"],
              [data-onboarding-step="4"] [data-onboarding="workspace-sessions"],
              [data-onboarding-step="5"] [data-onboarding="panel-resize-grip"] {
                outline: 2px solid hsl(var(--primary));
                outline-offset: 2px;
                border-radius: 0.5rem;
                box-shadow: 0 0 0 4px hsl(var(--primary) / 0.25);
              }
            `}</style>
          )}
          <div {...(showOnboardingHighlight ? { "data-onboarding-step": String(onboardingStep) } : {})}>
          <SidebarProvider>
            <TitleBar />
            {showWorkspaceChrome ? <AppSidebar /> : null}
            <div
              id="layout-main-content-container"
              className="relative flex h-screenish w-full overflow-hidden mt-12 mb-4 mr-4 border-t border-l border-border rounded-lg bg-background"
            >
              {showWorkspaceChrome && leftPanelVisible ? <LeftPanel /> : null}
              {/* Top-right panel toggle: always on chat page so panel works for web-only chats too */}
              {isOnChatPage && showWorkspaceChrome && (
                <button
                  type="button"
                  onClick={toggleRightPanel}
                  className="absolute top-3 right-3 z-20 flex items-center justify-center w-9 h-9 rounded-lg border border-border/60 bg-background/80 text-muted-foreground hover:text-foreground hover:bg-accent hover:border-border transition-colors shadow-sm"
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
              <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
                {/* Pending team invites (signed-in user) */}
                <PendingInviteBanner />
                {/* Auto-update: download progress + ready-to-install banner */}
                <UpdateBanner />
                {/* Workspace folder missing (deleted outside app) */}
                {isOnChatPage && <WorkspaceNotFoundBanner />}
                {/* Chat overlay on home when a chat is active; full-page routes still render their outlet */}
                <PersistentChatContainer />
                <div className="relative z-0 flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
                  {!suppressOutletForHomeChat && children}
                </div>
              </div>
              {/* Right panel: on chat page whenever visible (works for workspace and web-only chats) */}
              {rightPanelVisible && isOnChatPage && showWorkspaceChrome && (
                <RightPanel />
              )}
            </div>
            <Toaster richColors />
          </SidebarProvider>
          </div>
        </DeepLinkProvider>
      </ThemeProvider>
    </>
  );
}
