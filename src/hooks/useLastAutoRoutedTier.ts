import { useMemo } from "react";
import { useAtomValue } from "jotai";
import { chatMessagesByIdAtom, selectedChatIdAtom } from "@/atoms/chatAtoms";
import {
  findCatalogEntryBySlot,
  type AtlarixCoreTierPresentation,
} from "@/lib/atlarix-core-catalog";

export type AutoRoutedTierLabel = "fast" | "balanced" | "thinking";

/**
 * Last assistant message `autoRoutedTier` for the chat (for Auto · {model} UI).
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

export function formatAutoTierLabel(
  tier: AutoRoutedTierLabel | null,
  catalog: AtlarixCoreTierPresentation[] | undefined,
  autoProviderId?: string | null,
): string {
  if (!tier) return "";
  if (autoProviderId && autoProviderId !== "compass") {
    const slotNames: Record<AutoRoutedTierLabel, string> = {
      fast: "speed slot",
      balanced: "standard slot",
      thinking: "deep slot",
    };
    return slotNames[tier];
  }
  const entry = catalog ? findCatalogEntryBySlot(catalog, tier) : undefined;
  return entry?.labelWithProvider ?? tier;
}
