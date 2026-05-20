import { useCallback, useEffect, useRef, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { MessageSquare, MoreHorizontal } from "lucide-react";
import { useAtomValue, useSetAtom } from "jotai";
import { useNavigate } from "@tanstack/react-router";
import { IpcClient } from "@/ipc/ipc_client";
import type { Message, WorkspaceChatSession } from "@/ipc/ipc_types";
import {
  activeWorkspaceSessionIdAtom,
  loadedSessionResumeAtom,
  loadedSessionTruncatedAtom,
  workspaceSessionsRefreshAtom,
  chatIdToSessionIdAtom,
  workspaceSessionLoadingAtom,
  workspaceSessionLoadingLabelAtom,
} from "@/atoms/sessionAtoms";
import { SESSION_LOAD_MESSAGE_LIMIT, SESSION_LOAD_OVERLAY_DELAY_MS } from "@/constants/session_constants";
import {
  activeChatIdAtom,
  chatMessagesByIdAtom,
  selectedChatIdAtom,
} from "@/atoms/chatAtoms";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

let displayMessageId = -10000;

function sessionMessagesToUiMessages(
  sessionId: string,
  chatId: number,
  messages: { id: string; role: string; content: string; createdAt: Date }[],
): Message[] {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      id: displayMessageId--,
      role: m.role as "user" | "assistant",
      content: m.content,
      chatId,
      createdAt: m.createdAt,
    }));
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
  const setMessagesById = useSetAtom(chatMessagesByIdAtom);
  const setActiveChatId = useSetAtom(activeChatIdAtom);
  const setSelectedChatId = useSetAtom(selectedChatIdAtom);
  const sessionsRefreshKey = useAtomValue(workspaceSessionsRefreshAtom);

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
    setSessionSwitchBusy(true);
    setWorkspaceSessionLoadingLabel("Loading session…");
    if (overlayTimerRef.current) clearTimeout(overlayTimerRef.current);
    overlayTimerRef.current = setTimeout(() => {
      setWorkspaceSessionLoading(true);
    }, SESSION_LOAD_OVERLAY_DELAY_MS);

    try {
      const { session, messages, truncated } =
        await IpcClient.getInstance().getWorkspaceSession(sessionId, {
          limit: SESSION_LOAD_MESSAGE_LIMIT,
        });
      const chatId = await IpcClient.getInstance().createChat(workspaceId);
      await IpcClient.getInstance().clearEphemeralChatMessages(chatId);
      const uiMessages = sessionMessagesToUiMessages(
        session.id,
        chatId,
        messages,
      );
      setMessagesById((prev) => {
        const next = new Map(prev);
        next.set(chatId, uiMessages);
        return next;
      });
      setActiveSessionId(session.id);
      setLoadedResume(true);
      setLoadedTruncated(Boolean(truncated));
      setChatIdToSessionId((prev) => {
        const next = new Map(prev);
        next.set(chatId, session.id);
        return next;
      });
      setActiveChatId(chatId);
      setSelectedChatId(chatId);
      navigate({ to: "/" });
      onSessionsChange?.();
    } catch (e) {
      console.error("Failed to load session:", e);
    } finally {
      if (overlayTimerRef.current) {
        clearTimeout(overlayTimerRef.current);
        overlayTimerRef.current = null;
      }
      setWorkspaceSessionLoading(false);
      setSessionSwitchBusy(false);
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
      await loadSessions();
      onSessionsChange?.();
    } catch (e) {
      console.error("Failed to rename session:", e);
    }
  };

  const handleDelete = async (sessionId: string) => {
    if (!confirm("Delete this session and all its messages?")) return;
    try {
      await IpcClient.getInstance().deleteWorkspaceSession(sessionId);
      if (activeSessionId === sessionId) {
        setActiveSessionId(null);
        setLoadedResume(false);
      }
      await loadSessions();
      onSessionsChange?.();
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
            void handleSelectSession(session.id);
          }}
        >
          <MessageSquare className="h-3 w-3 text-muted-foreground flex-shrink-0" />
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
                <div className="text-xs truncate">{session.title}</div>
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
  );
}
