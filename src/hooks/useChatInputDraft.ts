import { useEffect, useRef } from "react";
import { useAtom, useAtomValue } from "jotai";
import { chatInputValueAtom } from "@/atoms/chatAtoms";
import { chatIdToSessionIdAtom } from "@/atoms/sessionAtoms";
import { loadDraft, saveDraft } from "@/lib/chat/input-drafts";

/** Debounce, so a fast typist does not write to localStorage on every keystroke. */
const SAVE_DEBOUNCE_MS = 400;

/**
 * Keep the composer's unsent text per session, and across a restart.
 *
 * `chatInputValueAtom` stays the single live editing value — this only mirrors it
 * to storage and back, so nothing about typing, dictation or the interjection
 * queue changes.
 *
 * THE RACE THIS GUARDS, because it is the whole reason for `ownerRef`. Two effects
 * run here: one loads when the session changes, one saves when the text changes.
 * On a switch, the save effect can observe the OUTGOING text with the INCOMING
 * session already in scope, and file session A's draft under session B. So every
 * save checks that the text still belongs to the session it was typed in, and the
 * loader is what re-stamps ownership.
 *
 * Sending needs no special handling: both submit paths set the value to "", and
 * `saveDraft` treats empty as a delete.
 */
export function useChatInputDraft(chatId: number): void {
  const [inputValue, setInputValue] = useAtom(chatInputValueAtom);
  const chatToSession = useAtomValue(chatIdToSessionIdAtom);
  const sessionId = chatToSession.get(chatId) ?? null;

  // Which session the value currently on screen was typed in.
  const ownerRef = useRef<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    if (ownerRef.current === sessionId) return;
    ownerRef.current = sessionId;
    const saved = loadDraft(sessionId);
    // Only overwrite the composer when there is something to restore. Writing ""
    // here would clear text the user is mid-way through typing in a session that
    // simply has no saved draft yet.
    if (saved) setInputValue(saved);
    else setInputValue("");
  }, [sessionId, setInputValue]);

  useEffect(() => {
    if (!sessionId) return;
    if (ownerRef.current !== sessionId) return;
    const t = setTimeout(
      () => saveDraft(sessionId, inputValue),
      SAVE_DEBOUNCE_MS,
    );
    return () => clearTimeout(t);
  }, [inputValue, sessionId]);

  // A quit does not run the debounce timer out, and closing the window is exactly
  // the case this feature exists for — so flush synchronously on the way down.
  useEffect(() => {
    const flush = () => {
      if (sessionId && ownerRef.current === sessionId) {
        saveDraft(sessionId, inputValue);
      }
    };
    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("pagehide", flush);
    };
  }, [inputValue, sessionId]);
}
