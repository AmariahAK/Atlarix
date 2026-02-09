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
import { WorkspacePanelBar } from "@/components/WorkspacePanelBar";
import { WorkspaceNotFoundBanner } from "@/components/WorkspaceNotFoundBanner";
import { rightPanelVisibleAtom, sourceListAtom, selectedSourceAtom, diagramStalenessAtom, diagramStateAtom } from "@/atoms/sourceAtoms";
import { useStreamChat } from "@/hooks/useStreamChat";
import { useLoadApp } from "@/hooks/useLoadApp";
import { PanelRightOpen, PanelRightClose } from "lucide-react";
import { cn } from "@/lib/utils";
import { IpcClient } from "@/ipc/ipc_client";

/**
 * PersistentChatContainer
 * =======================
 * Keeps the chat mounted at layout level so it persists across navigation.
 * Hidden when not on home page, but never unmounted.
 */
function PersistentChatContainer() {
  const location = useLocation();
  const [activeChatId, setActiveChatId] = useAtom(activeChatIdAtom);
  const rightPanelVisible = useAtomValue(rightPanelVisibleAtom);
  const setRightPanelVisible = useSetAtom(rightPanelVisibleAtom);
  const sources = useAtomValue(sourceListAtom);
  const setSourceList = useSetAtom(sourceListAtom);
  const setSelectedSource = useSetAtom(selectedSourceAtom);
  const setDiagramState = useSetAtom(diagramStateAtom);
  const { streamMessage } = useStreamChat({ hasChatId: false });
  const { isDarkMode } = useTheme();

  // Determine if we're on the home page
  const isHomePage = location.pathname === '/';

  // Handle continuing the chat conversation 
  const handleContinueChat = useCallback((prompt: string) => {
    if (!activeChatId || !prompt.trim()) return;
    streamMessage({
      prompt,
      chatId: activeChatId,
      attachments: [],
    });
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
          </div>
          <div className="flex items-center gap-2">
            {/* Source count badge */}
            {sources.length > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                {sources.length} sources
              </span>
            )}
            {/* Panel toggle button */}
            <button
              onClick={() => setRightPanelVisible(!rightPanelVisible)}
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              title={rightPanelVisible ? "Hide panel" : "Show panel"}
            >
              {rightPanelVisible ? (
                <PanelRightClose className="w-5 h-5" />
              ) : (
                <PanelRightOpen className="w-5 h-5" />
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
  const currentApp = useAtomValue(currentAppAtom);
  const rightPanelVisible = useAtomValue(rightPanelVisibleAtom);
  const setRightPanelVisible = useSetAtom(rightPanelVisibleAtom);
  const activeChatId = useAtomValue(activeChatIdAtom);
  const location = useLocation();
  // Diagram | Preview | Code bar only on chat (home with active chat, or /chat)
  const isOnChatPage = (location.pathname === "/" && !!activeChatId) || location.pathname.startsWith("/chat");
  const showWorkspacePanel = currentApp?.pathExists !== false;

  // Load diagram when workspace is selected (even before first prompt)
  useLoadApp(selectedAppId);

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
      <ThemeProvider>
        <DeepLinkProvider>
          <SidebarProvider>
            <TitleBar />
            <AppSidebar />
            <div
              id="layout-main-content-container"
              className="relative flex h-screenish w-full overflow-hidden mt-12 mb-4 mr-4 border-t border-l border-border rounded-lg bg-background"
            >
              {/* Top-right panel toggle: only on home/chat page when workspace or chat active and path exists */}
              {isOnChatPage && showWorkspacePanel && (selectedAppId || activeChatId) && (
                <button
                  type="button"
                  onClick={() => setRightPanelVisible(!rightPanelVisible)}
                  className="absolute top-2 right-2 z-20 p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                  title={rightPanelVisible ? "Hide panel" : "Show panel"}
                  aria-label={rightPanelVisible ? "Hide right panel" : "Show right panel"}
                >
                  {rightPanelVisible ? (
                    <PanelRightClose className="w-5 h-5" />
                  ) : (
                    <PanelRightOpen className="w-5 h-5" />
                  )}
                </button>
              )}
              {/* Main content: chat when active, else route content */}
              <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
                {/* Workspace panel bar: Diagram | Preview | Code - only on chat page when path exists */}
                {selectedAppId && isOnChatPage && showWorkspacePanel && <WorkspacePanelBar />}
                {/* Workspace folder missing (deleted outside app) */}
                {isOnChatPage && <WorkspaceNotFoundBanner />}
                {/* Chat overlay when active, else route content */}
                <PersistentChatContainer />
                {!activeChatId && children}
              </div>
              {/* Right panel: only on home/chat page when visible, workspace or chat active, and path exists */}
              {rightPanelVisible && (activeChatId || selectedAppId) && isOnChatPage && showWorkspacePanel && <RightPanel />}
            </div>
            <Toaster richColors />
          </SidebarProvider>
        </DeepLinkProvider>
      </ThemeProvider>
    </>
  );
}
