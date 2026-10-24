import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Loader2, MessageSquare, MoreHorizontal } from "lucide-react";
import { getDefaultStore, useAtomValue, useSetAtom } from "jotai";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
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
  pendingSessionHandoffAtom,
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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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
import { showError, showInfo } from "@/lib/toast";
import {
  diagStopwatch,
  sessionLoadDiagEnabled,
} from "@/lib/diag/session-load-diag";
import { shouldUseStreamingSessionFastPath } from "@/lib/chat/activity-stream";

/**
 * "6m" / "14h" / "4d" — the age column beside a session title.
 *
 * `formatDistanceToNow` is the right thing for a tooltip and the wrong thing for
 * a 240px sidebar: "less than a minute ago" is 21 characters competing with the
 * session's own name. This is the same fact at a width the column can afford;
 * the full phrasing stays in the row's `title`.
 */
function shortAge(date: Date): string {
  const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}

export function WorkspaceSessionList({
  workspaceId,
  activeSessionId,
  onSessionsChange,
}: {
  workspaceId: number;
  activeSessionId: string | null;
  onSessionsChange?: () => void;
}) {
  const { t } = useTranslation("panels");
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
  const setWorkspaceSessionLoadingLabel = useSetAtom(
    workspaceSessionLoadingLabelAtom,
  );
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
  const pendingHandoff = useAtomValue(pendingSessionHandoffAtom);
  const setPendingHandoff = useSetAtom(pendingSessionHandoffAtom);

  const loadSessions = useCallback(async () => {
    setListLoading(true);
    try {
      const list =
        await IpcClient.getInstance().listWorkspaceSessions(workspaceId);
      setSessions(list as WorkspaceChatSession[]);
      // Open tabs hold a title snapshot: a name given elsewhere (the CLI, an
      // editor) reaches them from the list (item 6).
      for (const s of list as WorkspaceChatSession[]) {
        if (s.title) updateOpenChatTabTitleForSession(s.id, s.title);
      }
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

  /**
   * Renderer-side forgetting of a session that main has deleted: its per-chat
   * atoms, its tab, and the session→chat binding. Shared by an explicit delete
   * and by pruning the empty session the user just left.
   */
  const forgetDeletedSession = async (
    sessionId: string,
    streamChatId: number | null,
  ) => {
    if (streamChatId != null) {
      // v12 (TODO 2.4): prune the per-chat jotai atoms for the deleted
      // session's transport — they were never cleared (renderer leak).
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
  };

  /**
   * Switch sessions, then remove the one left behind IF it was never used.
   * Main decides emptiness with the same guard reuse relies on; a session with
   * so much as one message is never touched.
   */
  const handleSelectSession = async (sessionId: string) => {
    const leaving = getDefaultStore().get(activeWorkspaceSessionIdAtom);
    await switchToSession(sessionId);
    const now = getDefaultStore().get(activeWorkspaceSessionIdAtom);
    if (!leaving || leaving === sessionId || now === leaving) return;
    try {
      const { pruned, streamChatId } =
        await IpcClient.getInstance().pruneWorkspaceSessionIfEmpty(leaving);
      if (!pruned) return;
      await forgetDeletedSession(leaving, streamChatId);
      await loadSessions();
      onSessionsChange?.();
    } catch (e) {
      console.error("Failed to prune the empty session:", e);
    }
  };

  const switchToSession = async (sessionId: string) => {
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
          listed ? (listed.model ?? null) : undefined,
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
        session.model ?? null,
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
          requestAnimationFrame(() =>
            paintWatch.stop("first frame after commit"),
          ),
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
      await forgetDeletedSession(sessionId, streamChatId);
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

  // NOTE: this hook must stay ABOVE the early returns below. It was first added
  // beneath them, which meant the loading render never called it and the next
  // render did — React #310, "rendered more hooks than during the previous
  // render", and a white error screen on every workspace open.
  /**
   * THE ACTIVE SESSION SORTS FIRST, whatever its timestamp says.
   *
   * `sessions:list` orders by `desc(updatedAt)`, which is right for the rest of
   * the list. But reopening a workspace REUSES an existing empty "Untitled"
   * rather than minting one (that is what stops the sidebar filling with
   * empties), so the session you are dropped into can be days old and land third
   * — reported 2026-09-08 with a screenshot showing exactly that.
   *
   * Fixed HERE and not by touching `updatedAt` on reuse, which was the first
   * attempt and is a tested prohibition: `session-reuse-guard.eval.test.ts`
   * asserts the row is untouched because "reusing and binding a session is not
   * something that happened IN the conversation", and drift there once caused a
   * real data-loss bug. Presentation order is a presentation concern.
   *
   * Stable within each group, so the rest of the list keeps recency order.
   */
  const ordered = useMemo(() => {
    if (!activeSessionId) return sessions;
    const active = sessions.filter((s) => s.id === activeSessionId);
    return active.length
      ? [...active, ...sessions.filter((s) => s.id !== activeSessionId)]
      : sessions;
  }, [sessions, activeSessionId]);

  // A session handed over from the CLI, or a fork: open it as if it had been clicked.
  useEffect(() => {
    if (!pendingHandoff || pendingHandoff.workspaceId !== workspaceId) return;
    setPendingHandoff(null);
    void loadSessions()
      .then(() => handleSelectSession(pendingHandoff.sessionId))
      .then(() => showInfo(pendingHandoff.note ?? "Continued from the terminal"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingHandoff, workspaceId]);

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
        {ordered.map((session) => (
          <div
            key={session.id}
            className={cn(
              // `sidebar-accent`, NOT `accent`. `--accent` is #f59e0b in BOTH
              // themes, so a selected row painted with it was a full-bleed amber
              // block with mint-green (`--muted-foreground`, #6ee7b7) timestamp
              // text on top at ~1.6:1. The rail next door was already using the
              // sidebar pair, which is why it read calm and this did not.
              "group relative flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer hover:bg-sidebar-accent",
              activeSessionId === session.id && "bg-sidebar-accent font-medium",
              sessionSwitchBusy && "opacity-50 pointer-events-none",
            )}
            onClick={() => {
              if (renamingId === session.id) return;
              // ALREADY-ACTIVE ROW: re-focus, do not no-op. This was a bare
              // `return`, which made the active row feel broken — you clicked it
              // and nothing happened, from anywhere in the app. Falling through to
              // handleSelectSession is the wrong fix: it re-runs
              // hydrateSessionIntoChat and re-loads a session already loaded. So
              // point the chat at it and navigate home, which is what the user
              // meant by clicking a row they can see is selected.
              if (activeSessionId === session.id) {
                const mapped = sessionIdToChatId.get(session.id);
                if (mapped != null) setActiveChatId(mapped);
                void navigate({ to: "/" });
                return;
              }
              void handleSelectSession(session.id);
            }}
          >
            {/* The selected marker. A 2px rule plus the tinted surface reads as
                "selected" without the row becoming a coloured block. */}
            {activeSessionId === session.id && (
              <span
                aria-hidden
                className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary"
              />
            )}
            {(() => {
              // backgroundStreamingSessionIdsAtom already applies the reverse-map
              // consistency guard (a stale forward entry can't spin the wrong row).
              const bgStream =
                activeSessionId !== session.id &&
                backgroundStreamingSessionIds.has(session.id);
              return bgStream ? (
                <Loader2 className="h-3 w-3 text-amber-600 animate-spin flex-shrink-0" />
              ) : (
                <MessageSquare
                  className={cn(
                    "h-3 w-3 flex-shrink-0",
                    activeSessionId === session.id
                      ? "text-primary"
                      : "text-muted-foreground",
                  )}
                />
              );
            })()}
            {renamingId === session.id ? (
              <Input
                className="h-6 flex-1 min-w-0 text-xs"
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
                <span className="flex-1 min-w-0 truncate text-xs">
                  {titleGeneratingIds.has(session.id) &&
                  session.title === "Untitled"
                    ? "Naming…"
                    : session.title}
                </span>
                {/*
                  ONE LINE, and the age is a column rather than a second row.
                  "about 14 hours ago" under every title cost 10px of height per
                  session and pushed three sessions to ~102px; the sidebar is
                  240px wide, so the vertical was the scarce axis, not the
                  horizontal. The full phrasing survives in the tooltip.

                  It goes INVISIBLE (not hidden) on hover and the menu button is
                  absolutely positioned over it, so the title never reflows when
                  the pointer crosses a row.
                */}
                <span
                  className="shrink-0 min-w-7 text-right text-[10px] text-muted-foreground tabular-nums group-hover:invisible"
                  title={formatDistanceToNow(new Date(session.updatedAt), {
                    addSuffix: true,
                  })}
                >
                  {shortAge(new Date(session.updatedAt))}
                </span>
              </>
            )}
            {renamingId !== session.id && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Session actions"
                    className="absolute right-0.5 top-1/2 h-7 w-7 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
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
                    onClick={(e) => {
                      e.stopPropagation();
                      // App → CLI handoff: the same session, in a terminal.
                      void IpcClient.getInstance()
                        .continueSessionInTerminal(session.id)
                        .then((r) =>
                          r.ok
                            ? showInfo("Opened in your terminal")
                            : showError(
                                new Error(
                                  r.error ?? "Couldn't open a terminal",
                                ),
                              ),
                        );
                    }}
                  >
                    {t("sessions.continueInTerminal")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      // A copy as saved now, opened beside the original (sessions:fork).
                      void IpcClient.getInstance()
                        .forkWorkspaceSession(session.id)
                        .then(async (made) => {
                          await loadSessions();
                          onSessionsChange?.();
                          await handleSelectSession(made.id);
                          showInfo(`Forked as “${made.title}”`);
                        })
                        .catch((err) => showError(err));
                    }}
                  >
                    {t("sessions.fork")}
                  </DropdownMenuItem>
                  {/* App → editor handoff: Atlarix's extension opens the same session (lib/peers/open-in-editor). */}
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger onClick={(e) => e.stopPropagation()}>
                      {t("sessions.openInEditor")}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {(
                        [
                          ["vscode", "VS Code"],
                          ["cursor", "Cursor"],
                          ["kiro", "Kiro"],
                          ["windsurf", "Windsurf"],
                        ] as const
                      ).map(([id, name]) => (
                        <DropdownMenuItem
                          key={id}
                          onClick={(e) => {
                            e.stopPropagation();
                            void IpcClient.getInstance()
                              .openSessionInEditor(session.id, id)
                              .then((r) =>
                                r.ok
                                  ? showInfo(`Opening in ${name}. The Atlarix extension picks it up.`)
                                  : showError(new Error(r.error ?? `Couldn't open ${name}`)),
                              );
                          }}
                        >
                          {name}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
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
