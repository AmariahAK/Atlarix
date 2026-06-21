import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { Clapperboard, Play, Pause, ChevronRight, ChevronDown, Monitor, Globe } from "lucide-react";
import { IpcClient } from "@/ipc/ipc_client";
import {
  sessionRecordingsByMessageIdAtom,
  type SessionReelRef,
} from "@/atoms/sourceAtoms";
import { cn } from "@/lib/utils";

interface ReelFrame {
  caption: string;
  type: string;
  ts: number;
  dataUrl: string;
}

/** Auto-advance cadence for playback (ms per frame). */
const FRAME_MS = 650;

function ReelPlayer({ reel }: { reel: SessionReelRef }) {
  const [frames, setFrames] = useState<ReelFrame[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Lazy-load frames the first time the player mounts (card expanded).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void IpcClient.getInstance()
      .mediaGetRecording(reel.chatId, reel.recordingId)
      .then((rec) => {
        if (cancelled) return;
        setFrames(rec?.frames ?? []);
        setPlaying((rec?.frames?.length ?? 0) > 1);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [reel.chatId, reel.recordingId]);

  // Auto-advance while playing.
  useEffect(() => {
    if (!playing || !frames || frames.length <= 1) return;
    timer.current = setInterval(() => {
      setIndex((i) => (i + 1) % frames.length);
    }, FRAME_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [playing, frames]);

  if (loading) {
    return <div className="px-2 py-6 text-center text-xs text-muted-foreground">Loading recording…</div>;
  }
  if (!frames || frames.length === 0) {
    return <div className="px-2 py-6 text-center text-xs text-muted-foreground">Recording unavailable.</div>;
  }

  const frame = frames[Math.min(index, frames.length - 1)]!;
  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded border border-border bg-black/40">
        <img src={frame.dataUrl} alt={frame.caption} className="w-full" />
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setPlaying((p) => !p)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted hover:bg-muted/70"
          title={playing ? "Pause" : "Play"}
        >
          {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </button>
        <input
          type="range"
          min={0}
          max={frames.length - 1}
          value={index}
          onChange={(e) => {
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

function ReelCard({ reel }: { reel: SessionReelRef }) {
  const [open, setOpen] = useState(false);
  const SurfaceIcon = reel.surface === "preview" ? Monitor : Globe;
  return (
    <div className="rounded-lg border border-border bg-muted/20">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <Clapperboard className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
        <span className="font-medium">Session recording</span>
        <SurfaceIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="text-muted-foreground">
          {reel.surface} · {reel.frameCount} frame{reel.frameCount === 1 ? "" : "s"}
        </span>
      </button>
      {open ? (
        <div className="border-t border-border px-2.5 py-2">
          <ReelPlayer reel={reel} />
        </div>
      ) : null}
    </div>
  );
}

/** All session recordings produced by a given assistant message's turn. */
export function SessionRecordingCards({ messageId }: { messageId: string | number | undefined }) {
  const byMessage = useAtomValue(sessionRecordingsByMessageIdAtom);
  const reels = messageId != null ? byMessage[String(messageId)] : undefined;
  if (!reels || reels.length === 0) return null;
  return (
    <div className={cn("mt-2 space-y-1.5")}>
      {reels.map((reel) => (
        <ReelCard key={reel.recordingId} reel={reel} />
      ))}
    </div>
  );
}
