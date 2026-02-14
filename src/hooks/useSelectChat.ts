import { useSetAtom } from "jotai";
import { selectedChatIdAtom } from "@/atoms/chatAtoms";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { useNavigate } from "@tanstack/react-router";

export function useSelectChat() {
  const setSelectedChatId = useSetAtom(selectedChatIdAtom);
  const setSelectedAppId = useSetAtom(selectedAppIdAtom);
  const navigate = useNavigate();

  return {
    selectChat: ({ chatId, appId }: { chatId: number; appId: number | null }) => {
      setSelectedChatId(chatId);
      setSelectedAppId(appId ?? null);
      navigate({
        to: "/chat",
        search: { id: chatId },
      });
    },
  };
}
