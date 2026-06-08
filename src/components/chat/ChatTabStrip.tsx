/**
 * Concurrent-session tab strip. Each tab is a workspace conversation the user
 * has opened this run (openChatTabsAtom). Switching tabs only changes the
 * active chat — background sessions keep streaming (their per-chat state lives
 * in the chat atoms keyed by chatId), so a second session never hides the
 * first. A live dot marks tabs that are currently streaming.
 */
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { X } from "lucide-react";
import {
  activeChatIdAtom,
  selectedChatIdAtom,
  isStreamingByIdAtom,
  openChatTabsAtom,
} from "@/atoms/chatAtoms";
import {
  selectedAppIdAtom,
  selectedWorkspaceInfoAtom,
  appsListAtom,
} from "@/atoms/appAtoms";
import { activeWorkspaceSessionIdAtom, chatIdToSessionIdAtom } from "@/atoms/sessionAtoms";
import { removeOpenChatTab } from "@/lib/open-workspace-session";
import { cn } from "@/lib/utils";

export function ChatTabStrip() {
  const tabs = useAtomValue(openChatTabsAtom);
  const [activeChatId, setActiveChatId] = useAtom(activeChatIdAtom);
  const setSelectedChatId = useSetAtom(selectedChatIdAtom);
  const setSelectedAppId = useSetAtom(selectedAppIdAtom);
  const setSelectedWorkspaceInfo = useSetAtom(selectedWorkspaceInfoAtom);
  const setActiveSessionId = useSetAtom(activeWorkspaceSessionIdAtom);
  const isStreamingById = useAtomValue(isStreamingByIdAtom);
  const chatIdToSessionId = useAtomValue(chatIdToSessionIdAtom);
  const appsList = useAtomValue(appsListAtom);

  // A single open session doesn't need a switcher.
  if (tabs.length < 2) return null;

  const switchToTab = (chatId: number, appId: number | null) => {
    if (chatId === activeChatId) return;
    setActiveChatId(chatId);
    setSelectedChatId(chatId);
    const sessionId = chatIdToSessionId.get(chatId) ?? null;
    setActiveSessionId(sessionId);
    if (appId != null) {
      setSelectedAppId(appId);
      const app = appsList.find((a) => a.id === appId);
      if (app) {
        setSelectedWorkspaceInfo({
          id: app.id,
          name: app.name,
          path: app.path ?? "",
        });
      }
    }
  };

  const closeTab = (e: React.MouseEvent, chatId: number) => {
    e.stopPropagation();
    const remaining = tabs.filter((t) => t.chatId !== chatId);
    removeOpenChatTab(chatId);
    // If we closed the active tab, fall back to the last remaining one.
    if (chatId === activeChatId) {
      const next = remaining[remaining.length - 1];
      if (next) {
        switchToTab(next.chatId, next.appId);
      } else {
        setActiveChatId(null);
      }
    }
  };

  return (
    <div className="flex-shrink-0 flex items-stretch gap-1 overflow-x-auto border-b border-border/40 bg-background/95 px-2">
      {tabs.map((tab) => {
        const isActive = tab.chatId === activeChatId;
        const isStreaming = isStreamingById.get(tab.chatId) ?? false;
        return (
          <button
            key={tab.chatId}
            type="button"
            onClick={() => switchToTab(tab.chatId, tab.appId)}
            className={cn(
              "group flex items-center gap-1.5 px-3 py-1.5 text-xs whitespace-nowrap border-b-2 transition-colors max-w-[180px]",
              isActive
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground hover:bg-accent/40",
            )}
            title={tab.title}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full shrink-0",
                isStreaming
                  ? "bg-emerald-500 animate-pulse"
                  : isActive
                    ? "bg-primary/60"
                    : "bg-transparent",
              )}
              aria-hidden
            />
            <span className="truncate">{tab.title}</span>
            <span
              role="button"
              tabIndex={-1}
              onClick={(e) => closeTab(e, tab.chatId)}
              className="opacity-0 group-hover:opacity-100 hover:bg-muted rounded p-0.5 transition-opacity shrink-0"
              aria-label="Close session tab"
            >
              <X className="h-3 w-3" />
            </span>
          </button>
        );
      })}
    </div>
  );
}
