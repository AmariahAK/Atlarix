/**
 * Concurrent-session tab strip. Each tab is a workspace conversation the user
 * has opened this run (openChatTabsAtom). Switching tabs only changes the
 * active chat — background sessions keep streaming (their per-chat state lives
 * in the chat atoms keyed by chatId), so a second session never hides the
 * first. A live dot marks tabs that are currently streaming.
 */
import { getDefaultStore, useAtom, useAtomValue, useSetAtom } from "jotai";
import { X } from "lucide-react";
import {
  activeChatIdAtom,
  chatMessagesByIdAtom,
  selectedChatIdAtom,
  isStreamingByIdAtom,
  isStreamingForChatAtom,
  openChatTabsAtom,
  type OpenChatTab,
} from "@/atoms/chatAtoms";
import {
  selectedAppIdAtom,
  selectedWorkspaceInfoAtom,
  appsListAtom,
} from "@/atoms/appAtoms";
import { activeWorkspaceSessionIdAtom, chatIdToSessionIdAtom } from "@/atoms/sessionAtoms";
import { removeOpenChatTab } from "@/lib/open-workspace-session";
import { hydrateSessionIntoChat } from "@/lib/chat/hydrate-session-into-chat";
import { isChatEvicted } from "@/lib/chat/clear-chat-atoms";
import { showError } from "@/lib/toast";
import { cn } from "@/lib/utils";

export function ChatTabStrip() {
  const tabs = useAtomValue(openChatTabsAtom);
  const [activeChatId, setActiveChatId] = useAtom(activeChatIdAtom);
  const setSelectedChatId = useSetAtom(selectedChatIdAtom);
  const setSelectedAppId = useSetAtom(selectedAppIdAtom);
  const setSelectedWorkspaceInfo = useSetAtom(selectedWorkspaceInfoAtom);
  const setActiveSessionId = useSetAtom(activeWorkspaceSessionIdAtom);
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

    /**
     * Bring the session back if its renderer state is gone.
     *
     * This function used to flip ids and nothing else, which quietly made the
     * atoms the only copy of a background session's history — so nothing could
     * ever be freed without turning a tab switch into an empty chat. Activation
     * being re-loadable is what makes cold-session eviction possible at all.
     *
     * Two conditions, and the second is the subtle one: `evicted` matters even
     * when the messages ARE present, because a background stream repopulates them
     * (main sends the whole list per chunk) without rebuilding the per-message
     * display atoms — so the history would come back rendering its earlier turns
     * stripped of their tool cards.
     *
     * Never for a streaming chat: the read would land on top of the live turn.
     */
    if (!sessionId) return;
    const store = getDefaultStore();
    if (store.get(isStreamingByIdAtom).get(chatId) === true) return;
    const hasMessages = (store.get(chatMessagesByIdAtom).get(chatId)?.length ?? 0) > 0;
    if (hasMessages && !isChatEvicted(chatId)) return;
    void hydrateSessionIntoChat({ sessionId, chatId }).catch((e) => {
      // Leave the tab switched — the user asked for it — but say so, because the
      // alternative is a chat that silently renders empty.
      console.error("Failed to restore session for tab switch:", e);
      showError("Could not load this session's history. Try reopening it.");
    });
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
      {tabs.map((tab) => (
        <ChatTab
          key={tab.chatId}
          tab={tab}
          isActive={tab.chatId === activeChatId}
          onSwitch={switchToTab}
          onClose={closeTab}
        />
      ))}
    </div>
  );
}

/**
 * One tab. Subscribes to ITS OWN chat's streaming state (isStreamingForChatAtom)
 * so only the tab whose streaming flips re-renders — a stream in one session no
 * longer re-renders the whole strip on every ~50ms flush.
 */
function ChatTab({
  tab,
  isActive,
  onSwitch,
  onClose,
}: {
  tab: OpenChatTab;
  isActive: boolean;
  onSwitch: (chatId: number, appId: number | null) => void;
  onClose: (e: React.MouseEvent, chatId: number) => void;
}) {
  const isStreaming = useAtomValue(isStreamingForChatAtom(tab.chatId));
  return (
    <button
      type="button"
      onClick={() => onSwitch(tab.chatId, tab.appId)}
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
        onClick={(e) => onClose(e, tab.chatId)}
        className="opacity-0 group-hover:opacity-100 hover:bg-muted rounded p-0.5 transition-opacity shrink-0"
        aria-label="Close session tab"
      >
        <X className="h-3 w-3" />
      </span>
    </button>
  );
}
