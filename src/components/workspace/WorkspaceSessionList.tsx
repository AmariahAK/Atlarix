import { useCallback, useEffect, useRef, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Loader2, MessageSquare, MoreHorizontal } from "lucide-react";
import { getDefaultStore, useAtomValue, useSetAtom } from "jotai";
import { useNavigate } from "@tanstack/react-router";
import { IpcClient } from "@/ipc/ipc_client";
import type { WorkspaceChatSession } from "@/ipc/ipc_types";
import {
  activeWorkspaceSessionIdAtom,
  loadedSessionResumeAtom,
  loadedSessionTruncatedAtom,
  workspaceSessionsRefreshAtom,
  workspaceSessionTitleGeneratingAtom,
  chatIdToSessionIdAtom,
  sessionIdToChatIdAtom,
  backgroundStreamingSessionIdsAtom,
  workspaceSessionLoadingAtom,
  workspaceSessionLoadingLabelAtom,
} from "@/atoms/sessionAtoms";
import { SESSION_LOAD_OVERLAY_DELAY_MS } from "@/constants/session_constants";
import {
  activeChatIdAtom,
  isStreamingByIdAtom,
  selectedChatIdAtom,
} from "@/atoms/chatAtoms";
import { hydrateSessionIntoChat } from "@/lib/chat/hydrate-session-into-chat";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { appsListAtom } from "@/atoms/appAtoms";
import { attachWorkspaceToChat } from "@/lib/chat-workspace-binding";
import {
  activateWorkspaceSession,
  registerOpenChatTab,
  removeOpenChatTab,
  startNewWorkspaceConversation,
  updateOpenChatTabTitleForSession,
} from "@/lib/open-workspace-session";
import type { WorkMode } from "@/lib/schemas";
import { showInfo } from "@/lib/toast";
import {
  diagStopwatch,
  sessionLoadDiagEnabled,
} from "@/lib/diag/session-load-diag";
import { shouldUseStreamingSessionFastPath } from "@/lib/chat/activity-stream";

export function WorkspaceSessionList({
  workspaceId,
  activeSessionId,
  onSessionsChange,
}: {
  workspaceId: number;
  activeSessionId: string | null;
  onSessionsChange?: () => void;
}) {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<WorkspaceChatSession[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [sessionSwitchBusy, setSessionSwitchBusy] = useState(false);
  const overlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const setActiveSessionId = useSetAtom(activeWorkspaceSessionIdAtom);
  const setLoadedResume = useSetAtom(loadedSessionResumeAtom);
  const setLoadedTruncated = useSetAtom(loadedSessionTruncatedAtom);
  const setWorkspaceSessionLoading = useSetAtom(workspaceSessionLoadingAtom);
  const setWorkspaceSessionLoadingLabel = useSetAtom(workspaceSessionLoadingLabelAtom);
  const setChatIdToSessionId = useSetAtom(chatIdToSessionIdAtom);
  const sessionIdToChatId = useAtomValue(sessionIdToChatIdAtom);
  const setSessionIdToChatId = useSetAtom(sessionIdToChatIdAtom);
  const isStreamingById = useAtomValue(isStreamingByIdAtom);
  // Membership-stable Set of sessions with an active background stream — drives
  // the spinner without subscribing to the whole chatIdToSessionId reverse map
  // (which churns on every streaming tick and over-rendered this list).
  const backgroundStreamingSessionIds = useAtomValue(
    backgroundStreamingSessionIdsAtom,
  );
  const setActiveChatId = useSetAtom(activeChatIdAtom);
  const activeChatIdValue = useAtomValue(activeChatIdAtom);
  const setSelectedChatId = useSetAtom(selectedChatIdAtom);
  const sessionsRefreshKey = useAtomValue(workspaceSessionsRefreshAtom);
  const titleGeneratingIds = useAtomValue(workspaceSessionTitleGeneratingAtom);
  const appsList = useAtomValue(appsListAtom);

  const loadSessions = useCallback(async () => {
    setListLoading(true);
    try {
      const list = await IpcClient.getInstance().listWorkspaceSessions(workspaceId);
      setSessions(list as WorkspaceChatSession[]);
    } catch (e) {
      console.error("Failed to load sessions:", e);
      setSessions([]);
    } finally {
      setListLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions, sessionsRefreshKey]);

  const handleSelectSession = async (sessionId: string) => {
    if (sessionSwitchBusy) return;

    const mappedChatId = sessionIdToChatId.get(sessionId);
    if (shouldUseStreamingSessionFastPath(mappedChatId, isStreamingById)) {
      setSessionSwitchBusy(true);
      try {
        const chatId = mappedChatId!;
        const workspaceApp = appsList.find((a) => a.id === workspaceId);
        attachWorkspaceToChat(
          chatId,
          workspaceId,
          workspaceApp
            ? { name: workspaceApp.name, path: workspaceApp.path ?? undefined }
            : undefined,
        );
        // No DB read on this path (reloading would clobber the live stream), so
        // take the mode from the list rows already loaded. If the session is not
        // in that list, pass `undefined` — "unknown, leave what is there" —
        // rather than `null`, which would assert it has no stored mode and
        // silently drop one it may have.
        const listed = sessions.find((s) => s.id === sessionId);
        activateWorkspaceSession(
          sessionId,
          listed ? ((listed.workMode ?? null) as WorkMode | null) : undefined,
        );
        setLoadedTruncated(false);
        setChatIdToSessionId((prev) => {
          const next = new Map(prev);
          next.set(chatId, sessionId);
          return next;
        });
        setActiveChatId(chatId);
        setSelectedChatId(chatId);
        registerOpenChatTab({
          chatId,
          appId: workspaceId,
          title:
            sessions.find((s) => s.id === sessionId)?.title ||
            workspaceApp?.name ||
            "Session",
        });
        navigate({ to: "/" });
        onSessionsChange?.();
      } catch (e) {
        console.error("Failed to switch to streaming session:", e);
      } finally {
        setSessionSwitchBusy(false);
      }
      return;
    }

    setSessionSwitchBusy(true);
    setWorkspaceSessionLoadingLabel("Loading session…");
    if (overlayTimerRef.current) clearTimeout(overlayTimerRef.current);
    overlayTimerRef.current = setTimeout(() => {
      setWorkspaceSessionLoading(true);
    }, SESSION_LOAD_OVERLAY_DELAY_MS);

    // Let React commit and PAINT the overlay before any of the load runs.
    //
    // Without this the whole load is one synchronous-ish run of the event loop: the
    // overlay timer fires but its state write cannot be painted, so a slow load shows
    // the user a frozen window rather than a spinner — reported as a macOS beach ball.
    // The delay above only prevents a flash on fast loads; it does nothing to make the
    // overlay reachable on slow ones. One macrotask is enough to hand the main thread
    // back to the compositor, and it costs a frame on loads that were never slow.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // Whole-load stopwatch: every span below is a slice of this, so the slices
    // have to account for it or something unmeasured is eating the time.
    const loadWatch = diagStopwatch("renderer: TOTAL handleSelectSession");
    try {
      let chatId = sessionIdToChatId.get(sessionId);
      if (chatId == null) {
        ({ chatId } =
          await IpcClient.getInstance().allocateSessionTransport(sessionId));
        setSessionIdToChatId((prev) => {
          const next = new Map(prev);
          next.set(sessionId, chatId!);
          return next;
        });
      }
      const workspaceApp = appsList.find((a) => a.id === workspaceId);
      attachWorkspaceToChat(
        chatId,
        workspaceId,
        workspaceApp
          ? { name: workspaceApp.name, path: workspaceApp.path ?? undefined }
          : undefined,
      );
      // The read, the shaping, the transport hydration and the display
      // rehydration all live in one place now, because the tab strip needs the
      // identical sequence to bring a cold session back.
      const { session, truncated } = await hydrateSessionIntoChat({
        sessionId,
        chatId,
      });
      // The session row is right here, so the mode is hydrated in the same beat
      // as the id — an activation that sets one without the other leaves the
      // PREVIOUS session's mode both on the chip and driving the next turn.
      activateWorkspaceSession(
        session.id,
        (session.workMode ?? null) as WorkMode | null,
      );
      setLoadedTruncated(Boolean(truncated));
      // Only a genuinely prior-launch session is "restored" — a session opened
      // earlier this launch (already in sessionIdToChatId) is a silent switch.
      if (mappedChatId == null) showInfo("Restored previous session");
      setChatIdToSessionId((prev) => {
        const next = new Map(prev);
        next.set(chatId, session.id);
        return next;
      });
      setActiveChatId(chatId);
      setSelectedChatId(chatId);
      registerOpenChatTab({
        chatId,
        appId: workspaceId,
        title: session.title || workspaceApp?.name || "Session",
      });
      navigate({ to: "/" });
      onSessionsChange?.();
      // Two frames after the state writes: the first is the commit, the second is
      // the browser having actually painted it. This is the number the user feels —
      // everything before it is time the window spent unresponsive.
      if (sessionLoadDiagEnabled()) {
        const paintWatch = diagStopwatch("renderer: state → painted");
        requestAnimationFrame(() =>
          requestAnimationFrame(() => paintWatch.stop("first frame after commit")),
        );
      }
    } catch (e) {
      console.error("Failed to load session:", e);
    } finally {
      if (overlayTimerRef.current) {
        clearTimeout(overlayTimerRef.current);
        overlayTimerRef.current = null;
      }
      setWorkspaceSessionLoading(false);
      setSessionSwitchBusy(false);
      loadWatch.stop();
    }
  };

  const handleRename = async (sessionId: string) => {
    const title = renameValue.trim();
    if (!title) {
      setRenamingId(null);
      return;
    }
    try {
      await IpcClient.getInstance().renameWorkspaceSession(sessionId, title);
      setRenamingId(null);
      // v14.8.11: keep the tab strip + other sidebar instances in sync — the
      // tab title is a snapshot and this path never bumped the refresh atom.
      updateOpenChatTabTitleForSession(sessionId, title);
      getDefaultStore().set(workspaceSessionsRefreshAtom, (n) => n + 1);
      await loadSessions();
      onSessionsChange?.();
    } catch (e) {
      console.error("Failed to rename session:", e);
    }
  };

  const handleDelete = async (sessionId: string) => {
    if (!confirm("Delete this session and all its messages?")) return;
    try {
      const { streamChatId } =
        await IpcClient.getInstance().deleteWorkspaceSession(sessionId);
      // v12 (TODO 2.4): prune the per-chat jotai atoms for the deleted
      // session's transport — they were never cleared (renderer leak).
      if (streamChatId != null) {
        const { clearChatAtomsForChat } = await import(
          "@/lib/chat/clear-chat-atoms"
        );
        clearChatAtomsForChat(streamChatId);
        // Drop its concurrent-session tab too (otherwise a dead tab lingers).
        removeOpenChatTab(streamChatId);
      }
      // Prune the forward session→chat binding so a deleted session can never
      // leave a stale entry that mis-attributes a spinner to it later.
      setSessionIdToChatId((prev) => {
        if (!prev.has(sessionId)) return prev;
        const next = new Map(prev);
        next.delete(sessionId);
        return next;
      });
      if (streamChatId != null) {
        if (activeChatIdValue === streamChatId) {
          setActiveChatId(null);
        }
      }
      if (activeSessionId === sessionId) {
        setActiveSessionId(null);
        setLoadedResume(false);
        // Deleting the active session previously left every atom null, which
        // dropped the user back to the workspace selector. Instead open a fresh
        // session in the same workspace (reuses an empty default session if one
        // exists). Falls back to the cleared state if it can't start one.
        const startedChatId = await startNewWorkspaceConversation({
          workspaceId,
          navigate,
        });
        await loadSessions();
        onSessionsChange?.();
        if (startedChatId != null) return;
      } else {
        await loadSessions();
        onSessionsChange?.();
      }
    } catch (e) {
      console.error("Failed to delete session:", e);
    }
  };

  if (listLoading) {
    return (
      <div className="text-[10px] text-muted-foreground py-1 px-2">
        Loading sessions...
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="text-[10px] text-muted-foreground py-1 px-2">
        No saved sessions yet.
      </div>
    );
  }

  return (
    <>
    <div className="space-y-0.5 pb-1">
      {sessions.map((session) => (
        <div
          key={session.id}
          className={cn(
            "group flex items-center gap-1 px-2 py-1 rounded cursor-pointer hover:bg-accent",
            activeSessionId === session.id && "bg-accent",
            sessionSwitchBusy && "opacity-50 pointer-events-none",
          )}
          onClick={() => {
            if (renamingId === session.id) return;
            if (activeSessionId === session.id) return;
            void handleSelectSession(session.id);
          }}
        >
          {(() => {
            // backgroundStreamingSessionIdsAtom already applies the reverse-map
            // consistency guard (a stale forward entry can't spin the wrong row).
            const bgStream =
              activeSessionId !== session.id &&
              backgroundStreamingSessionIds.has(session.id);
            return bgStream ? (
              <Loader2 className="h-3 w-3 text-amber-600 animate-spin flex-shrink-0" />
            ) : (
              <MessageSquare className="h-3 w-3 text-muted-foreground flex-shrink-0" />
            );
          })()}
          <div className="flex-1 min-w-0">
            {renamingId === session.id ? (
              <Input
                className="h-6 text-xs"
                value={renameValue}
                autoFocus
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleRename(session.id);
                  if (e.key === "Escape") setRenamingId(null);
                }}
                onBlur={() => void handleRename(session.id)}
              />
            ) : (
              <>
                <div className="text-xs truncate">
                  {titleGeneratingIds.has(session.id) && session.title === "Untitled"
                    ? "Naming…"
                    : session.title}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {formatDistanceToNow(new Date(session.updatedAt), {
                    addSuffix: true,
                  })}
                </div>
              </>
            )}
          </div>
          {renamingId !== session.id && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 opacity-0 group-hover:opacity-100 shrink-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-36">
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    setRenamingId(session.id);
                    setRenameValue(session.title);
                  }}
                >
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleDelete(session.id);
                  }}
                >
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      ))}
    </div>
    </>
  );
}
