import { useMemo } from "react";
import { useAtomValue } from "jotai";
import { chatMessagesByIdAtom, selectedChatIdAtom } from "@/atoms/chatAtoms";

export type AutoRoutedTierLabel = "fast" | "balanced" | "thinking";

/**
 * Last assistant message `autoRoutedTier` for the chat (for Auto · {tier} UI).
 */
export function useLastAutoRoutedTier(chatId: number | null | undefined): AutoRoutedTierLabel | null {
  const messagesById = useAtomValue(chatMessagesByIdAtom);
  const selectedChatId = useAtomValue(selectedChatIdAtom);
  const id = chatId ?? selectedChatId ?? null;

  return useMemo(() => {
    if (id == null) return null;
    const msgs = messagesById.get(id);
    if (!msgs?.length) return null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!;
      if (m.role === "assistant" && m.autoRoutedTier) {
        return m.autoRoutedTier as AutoRoutedTierLabel;
      }
    }
    return null;
  }, [messagesById, id]);
}

export function formatAutoTierLabel(tier: AutoRoutedTierLabel | null): string {
  if (!tier) return "";
  if (tier === "fast") return "Fast";
  if (tier === "balanced") return "Balanced";
  return "Thinking";
}
