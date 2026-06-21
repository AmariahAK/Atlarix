import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { Play, Pause, Loader2, ChevronLeft, ChevronRight } from "lucide-react";
import { IpcClient } from "@/ipc/ipc_client";
import {
  sessionRecordingsByMessageIdAtom,
  type SessionReelRef,
} from "@/atoms/sourceAtoms";
import { VisualArtifactCard } from "./VisualArtifactCard";

interface ReelFrame {
  caption: string;
  type: string;
  ts: number;
  dataUrl: string;
}

/** Auto-advance cadence for playback (ms per frame). */
const FRAME_MS = 650;

function ReelPlayer({ reel }: { reel: SessionReelRef }) {
  const [frames, setFrames] = useState<ReelFrame[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  // Once the user scrubs or hits play, stop auto-following the recording tail so
  // they can step through every frame at their own pace.
  const pinnedRef = useRef(false);

  // (Re)load frames whenever the reel grows or finalizes. The backend emits a
  // throttled frameCount update (~1/s) while recording, so this gives a live
  // refresh without a separate polling timer.
  useEffect(() => {
    let cancelled = false;
    void IpcClient.getInstance()
      .mediaGetRecording(reel.chatId, reel.recordingId)
      .then((rec) => {
        if (cancelled || !rec) return;
        setFrames(rec.frames);
        if (rec.frames.length === 0) return;
        // Follow the tail ONLY while still recording and the user hasn't taken
        // manual control; otherwise just clamp the index into range.
        if (reel.live && !pinnedRef.current) {
          setIndex(rec.frames.length - 1);
        } else {
          setIndex((i) => Math.min(i, rec.frames.length - 1));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reel.chatId, reel.recordingId, reel.frameCount, reel.live]);

  // Optional playback loop — only when the user pressed play. Never fights
  // manual scrubbing or the live tail-follow.
  useEffect(() => {
    if (!playing || frames.length <= 1) return;
    const id = setInterval(() => {
      setIndex((i) => (i + 1) % frames.length);
    }, FRAME_MS);
    return () => clearInterval(id);
  }, [playing, frames.length]);

  if (frames.length === 0) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {reel.live ? "Recording…" : "Loading recording…"}
      </div>
    );
  }

  const frame = frames[Math.min(index, frames.length - 1)]!;
  const step = (delta: number) => {
    pinnedRef.current = true;
    setPlaying(false);
    setIndex((i) => Math.max(0, Math.min(frames.length - 1, i + delta)));
  };
  return (
    <div className="flex h-full flex-col gap-2 p-2">
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded border border-border bg-black/40">
        <img src={frame.dataUrl} alt={frame.caption} className="max-h-full max-w-full object-contain" />
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => step(-1)}
          disabled={index <= 0}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted hover:bg-muted/70 disabled:opacity-30"
          title="Previous frame"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => {
            pinnedRef.current = true;
            setPlaying((p) => !p);
          }}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted hover:bg-muted/70"
          title={playing ? "Pause" : "Play"}
        >
          {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={() => step(1)}
          disabled={index >= frames.length - 1}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted hover:bg-muted/70 disabled:opacity-30"
          title="Next frame"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
        <input
          type="range"
          min={0}
          max={frames.length - 1}
          value={index}
          onChange={(e) => {
            pinnedRef.current = true;
            setPlaying(false);
            setIndex(Number(e.target.value));
          }}
          className="h-1 flex-1 cursor-pointer accent-emerald-500"
        />
        <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">
          {index + 1}/{frames.length}
        </span>
      </div>
      <div className="truncate px-1 text-[11px] text-muted-foreground" title={frame.caption}>
        {frame.caption}
      </div>
    </div>
  );
}

function reelTitle(reel: SessionReelRef): string {
  const surface = reel.surface === "preview" ? "preview" : "browser";
  const base = `Session recording · ${surface}`;
  return reel.live ? `${base} · recording…` : `${base} · ${reel.frameCount} frames`;
}

/** All session recordings produced by a given assistant message's turn. */
export function SessionRecordingCards({ messageId }: { messageId: string | number | undefined }) {
  const byMessage = useAtomValue(sessionRecordingsByMessageIdAtom);
  const reels = messageId != null ? byMessage[String(messageId)] : undefined;
  if (!reels || reels.length === 0) return null;
  return (
    <>
      {reels.map((reel) => (
        <VisualArtifactCard
          key={reel.recordingId}
          title={reelTitle(reel)}
          layout="canvas"
          defaultExpanded={false}
        >
          <ReelPlayer reel={reel} />
        </VisualArtifactCard>
      ))}
    </>
  );
}
