/**
 * Embedded chat tab — shown in the right panel when the chat area is hidden.
 * Same session as main chat: same chatId, messages atom, send flow.
 * Model selection uses CompactModelSearch (no full sidebar).
 */

import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { activeChatIdAtom } from "@/atoms/chatAtoms";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { startNewWorkspaceConversation } from "@/lib/open-workspace-session";
import {
  rightPanelVisibleAtom,
  rightPanelSuppressAutoOpenAtom,
  diagramStateAtom,
  sourceListAtom,
  selectedSourceAtom,
} from "@/atoms/sourceAtoms";
import { SimpleInlineChat } from "@/components/SimpleInlineChat";
import { IpcClient } from "@/ipc/ipc_client";
import { useStreamChat } from "@/hooks/useStreamChat";
import { Plus } from "lucide-react";
import { showError } from "@/lib/toast";
import type { FileAttachment } from "@/ipc/ipc_types";

export function EmbeddedChatTab() {
  const navigate = useNavigate();
  const activeChatId = useAtomValue(activeChatIdAtom);
  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const setActiveChatId = useSetAtom(activeChatIdAtom);
  const setRightPanelVisible = useSetAtom(rightPanelVisibleAtom);
  const setSuppressRightAutoOpen = useSetAtom(rightPanelSuppressAutoOpenAtom);
  const setDiagramState = useSetAtom(diagramStateAtom);
  const setSourceList = useSetAtom(sourceListAtom);
  const setSelectedSource = useSetAtom(selectedSourceAtom);
  const { streamMessage } = useStreamChat({ hasChatId: false });

  const handleContinueChat = useCallback(
    async (prompt: string, attachments?: FileAttachment[]) => {
      if (!activeChatId || (!prompt.trim() && (attachments?.length ?? 0) === 0)) return;
      try {
        const chat = await IpcClient.getInstance().getChat(activeChatId);
        if (chat.appId != null) {
          const app = await IpcClient.getInstance().getApp(chat.appId);
          if (app.pathExists === false) {
            showError(
              "Workspace folder not found. It may have been moved or deleted. Remove it from the list and try again."
            );
            return;
          }
        }
        streamMessage({
          prompt,
          chatId: activeChatId,
          attachments: attachments ?? [],
        });
      } catch {
        streamMessage({ prompt, chatId: activeChatId, attachments: attachments ?? [] });
      }
    },
    [activeChatId, streamMessage]
  );

  const handleNewChat = useCallback(() => {
    if (selectedAppId != null) {
      void startNewWorkspaceConversation({
        workspaceId: selectedAppId,
        navigate: (opts) => navigate(opts),
      }).then((chatId) => {
        if (chatId != null) {
          setSourceList([]);
          setSelectedSource(null);
          setSuppressRightAutoOpen(true);
          setDiagramState(null);
        }
      });
      return;
    }
    setActiveChatId(null);
    setSourceList([]);
    setSelectedSource(null);
    setSuppressRightAutoOpen(true);
    setRightPanelVisible(false);
    setDiagramState(null);
  }, [
    selectedAppId,
    navigate,
    setActiveChatId,
    setSourceList,
    setSelectedSource,
    setSuppressRightAutoOpen,
    setRightPanelVisible,
    setDiagramState,
  ]);

  if (activeChatId == null) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-6 text-center">
        <p className="text-sm">No active chat.</p>
        <p className="text-xs mt-2">Start or select a chat from the main area.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-w-0">
      <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/20">
        <button
          type="button"
          onClick={handleNewChat}
          className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          New chat
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        <SimpleInlineChat
          chatId={activeChatId}
          onSendMessage={handleContinueChat}
        />
      </div>
    </div>
  );
}
