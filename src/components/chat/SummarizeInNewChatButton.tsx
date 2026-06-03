import { useNavigate } from "@tanstack/react-router";
import { getDefaultStore, useAtomValue } from "jotai";
import { selectedChatIdAtom } from "@/atoms/chatAtoms";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { activeWorkspaceSessionIdAtom } from "@/atoms/sessionAtoms";
import { useStreamChat } from "@/hooks/useStreamChat";
import { showError } from "@/lib/toast";
import { startNewWorkspaceConversation } from "@/lib/open-workspace-session";

export function useSummarizeInNewChat() {
  const chatId = useAtomValue(selectedChatIdAtom);
  const appId = useAtomValue(selectedAppIdAtom);
  const { streamMessage } = useStreamChat();
  const navigate = useNavigate();

  const handleSummarize = async () => {
    if (!appId) {
      console.error("No app id found");
      return;
    }
    if (!chatId) {
      console.error("No chat id found");
      return;
    }
    try {
      const priorChatId = chatId;
      const newChatId = await startNewWorkspaceConversation({
        workspaceId: appId,
        navigate,
      });
      if (newChatId == null) return;
      const newSessionId = getDefaultStore().get(activeWorkspaceSessionIdAtom);
      await streamMessage({
        prompt: "Summarize from chat-id=" + priorChatId,
        chatId: newChatId,
        workspaceSessionId: newSessionId ?? undefined,
      });
    } catch (err) {
      showError(err);
    }
  };

  return { handleSummarize };
}
