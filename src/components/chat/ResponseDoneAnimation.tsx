import { useEffect, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  activeChatIdAtom,
  responseDoneAnimationAtom,
  selectedChatIdAtom,
} from "@/atoms/chatAtoms";
import AtlarixAnimation from "@/components/atlarix/AtlarixAnimation";

/**
 * v3.5: Brief "done" phase of the Atlarix animation when an AI response completes.
 * Shows the formed "A" for ~2 seconds then hides. Visible in the chat area so user sees completion.
 */
export function ResponseDoneAnimation() {
  const doneState = useAtomValue(responseDoneAnimationAtom);
  const setDoneAnimation = useSetAtom(responseDoneAnimationAtom);
  const activeChatId = useAtomValue(activeChatIdAtom);
  const selectedChatId = useAtomValue(selectedChatIdAtom);
  const currentChatId = activeChatId ?? selectedChatId;
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!doneState || doneState.chatId !== currentChatId) return;
    const remaining = doneState.until - Date.now();
    if (remaining <= 0) {
      setDoneAnimation(null);
      return;
    }
    timeoutRef.current = setTimeout(() => {
      setDoneAnimation(null);
      timeoutRef.current = null;
    }, remaining);
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [doneState, currentChatId, setDoneAnimation]);

  if (!doneState || doneState.chatId !== currentChatId || Date.now() >= doneState.until) {
    return null;
  }

  return (
    <div className="flex justify-center py-2">
      <AtlarixAnimation size="sm" phase="done" />
    </div>
  );
}
