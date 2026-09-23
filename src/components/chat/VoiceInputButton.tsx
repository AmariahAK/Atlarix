/**
 * Mic dictation button for the composer.
 *
 * SHOWN ONLY WHEN DICTATION CAN ACTUALLY HAPPEN. It used to be unconditional,
 * because the fallback was a free on-device model that was always there; that
 * model is deleted (see `useVoiceInput.ts`), so the button now follows a
 * capability the way the Deep-thinking toggle does — a BYOK speech key, or a
 * selected model that declares audio input. Neither, and it renders nothing.
 *
 * Talk, then the transcript is inserted into the composer for review before
 * sending.
 */

import { Loader2, Mic, Square } from "lucide-react";
import { toast } from "sonner";
import { useEffect, useRef } from "react";
import { useSetAtom } from "jotai";
import { voiceDictationByChatAtom } from "@/atoms/chatAtoms";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSettings } from "@/hooks/useSettings";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import { useVoiceCapability } from "@/hooks/useVoiceCapability";
import type { VoiceRoute } from "@/hooks/useVoiceCapability";
import { resolveVoiceLanguage } from "@/lib/voice/language";

interface VoiceInputButtonProps {
  disabled?: boolean;
  /** Insert transcribed text into the composer (interim replaces, final appends). */
  onInsertText: (text: string, isFinal: boolean) => void;
  /** Only for usage attribution when transcribing through the chat model. */
  chatId?: number;
}

export function VoiceInputButton(props: VoiceInputButtonProps) {
  const route = useVoiceCapability();
  // The gate is OUTSIDE the hook-bearing component on purpose: `useVoiceInput`
  // owns a MediaRecorder and a live MediaStream, and mounting that machinery for
  // a button that is about to render `null` would hold a device handle for
  // nothing. An early `return null` after the hooks would still have run them.
  if (!route) return null;
  return <VoiceInputButtonWithRoute {...props} route={route} />;
}

function VoiceInputButtonWithRoute({
  disabled,
  onInsertText,
  chatId,
  route,
}: VoiceInputButtonProps & { route: VoiceRoute }) {
  const { settings } = useSettings();
  // Without this the engine got `undefined` and detected the language on every
  // clip — unreliable on short dictation and a silent source of bad transcripts.
  const language = resolveVoiceLanguage(settings?.voiceLanguage);
  const errorShownRef = useRef<string | null>(null);

  const voice = useVoiceInput({
    route,
    language,
    chatId,
    onTranscript: onInsertText,
  });
  const {
    isRecording,
    isTranscribing,
    error,
    start,
    stop,
    supported,
    hasPartial,
    levels,
    waveform,
    recordedMs,
    recordingStartedAt,
    cancel,
  } = voice;
  // Published per chat for the dictation strip above the composer (see
  // voiceDictationByChatAtom for why this is an atom).
  const setDictation = useSetAtom(voiceDictationByChatAtom);
  useEffect(() => {
    if (chatId == null) return;
    setDictation((prev) => {
      const next = new Map(prev);
      if (isRecording || isTranscribing) {
        next.set(chatId, {
          isRecording,
          isTranscribing,
          hasPartial,
          levels,
          waveform,
          recordedMs,
          recordingStartedAt,
          cancel,
        });
      } else if (!next.delete(chatId)) {
        return prev;
      }
      return next;
    });
  }, [
    chatId,
    setDictation,
    isRecording,
    isTranscribing,
    hasPartial,
    levels,
    waveform,
    recordedMs,
    recordingStartedAt,
    cancel,
  ]);
  // Unmounting mid-dictation (route lost, composer torn down) must not leave
  // the strip on screen.
  useEffect(
    () => () => {
      if (chatId == null) return;
      setDictation((prev) => {
        if (!prev.has(chatId)) return prev;
        const next = new Map(prev);
        next.delete(chatId);
        return next;
      });
    },
    [chatId, setDictation],
  );

  useEffect(() => {
    if (error && error !== errorShownRef.current) {
      errorShownRef.current = error;
      toast.error(error);
    }
    if (!error) errorShownRef.current = null;
  }, [error]);

  if (!supported) return null;

  const title = isRecording
    ? "Stop & transcribe"
    : isTranscribing
      ? "Transcribing…"
      : route.kind === "byok"
        ? `Dictate (${route.provider})`
        : "Dictate (current model)";

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={
              isRecording ? "mx-1 text-red-500 hover:text-red-600" : "mx-1"
            }
            disabled={disabled || (isTranscribing && !isRecording)}
            onClick={() => (isRecording ? stop() : void start())}
            title={title}
            aria-label={title}
          >
            {isRecording ? (
              <Square className="h-4 w-4 fill-current animate-pulse" />
            ) : isTranscribing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Mic className="h-4 w-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{title}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
