import { useEffect } from "react";
import { useAtom, useAtomValue } from "jotai";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { isStreamingForChatAtom, peerSettingsNoticeByChatIdAtom } from "@/atoms/chatAtoms";

/**
 * "Mode set to Review by Rix. From the next turn." above the composer, when
 * another session changed this chat's mode or model (item 9). It goes when
 * that next turn starts, or when you close it.
 */
export function PeerSettingsNotice({ chatId }: { chatId: number }) {
  const { t } = useTranslation("chat");
  const [notices, setNotices] = useAtom(peerSettingsNoticeByChatIdAtom);
  const streaming = useAtomValue(isStreamingForChatAtom(chatId));
  const notice = notices.get(chatId);

  const clear = () =>
    setNotices((prev) => {
      if (!prev.has(chatId)) return prev;
      const next = new Map(prev);
      next.delete(chatId);
      return next;
    });

  // The next turn is the one it was for.
  useEffect(() => {
    if (streaming && notice) clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming]);

  if (!notice) return null;
  return (
    <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground">
      <span>{notice}</span>
      <button type="button" aria-label={t("sessionRating.dismiss")} className="hover:text-foreground" onClick={clear}>
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
