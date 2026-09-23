/**
 * The dictation strip above the composer.
 *
 * WHY IT EXISTS: transcription can take several seconds on a long clip or a
 * slow model, and the only sign of it used to be a spinner inside the mic
 * button — which reads as "stuck". Now the wait is visible where the words will
 * land: a live meter while listening, then the clip's own waveform swept while
 * it transcribes, with a way out.
 *
 * It sits ABOVE the textarea rather than over it so text typed before
 * dictating stays readable. It hides the moment streamed words start arriving,
 * because at that point the words themselves are the progress.
 */
import { useAtomValue } from "jotai";
import { X } from "lucide-react";
import { voiceDictationByChatAtom } from "@/atoms/chatAtoms";
import { TextShimmer } from "@/components/chat/TextShimmer";
import { cn } from "@/lib/utils";

export interface VoiceDictationState {
  isRecording: boolean;
  isTranscribing: boolean;
  hasPartial: boolean;
  levels: number[];
  waveform: number[];
  recordedMs: number;
  recordingStartedAt: number;
  cancel: () => void;
}

export function formatClipDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function Bars({
  values,
  sweeping,
  className,
}: {
  values: number[];
  sweeping?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn("flex h-4 items-center gap-[2px]", className)}
    >
      {values.map((v, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: bars are positional
          key={i}
          className={cn(
            "w-[3px] rounded-full bg-primary/70",
            sweeping && "voice-wave-sweep",
          )}
          style={{
            height: `${Math.max(12, Math.round(v * 100))}%`,
            animationDelay: sweeping ? `${i * 45}ms` : undefined,
          }}
        />
      ))}
    </span>
  );
}

export function VoiceDictationStatus({ chatId }: { chatId: number }) {
  const state = useAtomValue(voiceDictationByChatAtom).get(chatId);
  if (!state) return null;
  const { isRecording, isTranscribing, hasPartial } = state;
  if (!isRecording && !(isTranscribing && !hasPartial)) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="voice-dictation-status"
      className="flex items-center gap-2 px-4 pt-2 text-xs text-muted-foreground"
    >
      {isRecording ? (
        <>
          <span className="h-2 w-2 shrink-0 rounded-full bg-red-500 animate-pulse" />
          <Bars values={padLive(state.levels)} />
          <span>
            Listening {formatClipDuration(Date.now() - state.recordingStartedAt)}
            {" · "}press stop to transcribe
          </span>
        </>
      ) : (
        <>
          <Bars values={state.waveform} sweeping />
          <TextShimmer>
            Transcribing {formatClipDuration(state.recordedMs)} of audio…
          </TextShimmer>
        </>
      )}
      <button
        type="button"
        onClick={state.cancel}
        className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground"
        aria-label="Cancel dictation"
        title="Cancel dictation"
      >
        <X className="h-3 w-3" />
        Cancel
      </button>
    </div>
  );
}

/** The live meter always shows the same number of bars, filling from the right. */
function padLive(levels: number[]): number[] {
  const n = 12;
  return [...new Array(Math.max(0, n - levels.length)).fill(0), ...levels].slice(
    -n,
  );
}
