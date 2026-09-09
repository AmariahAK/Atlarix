import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Even out how fast a streamed answer *appears*, so the reading experience does not
 * depend on which provider happens to be serving the model.
 *
 * The renderer flushes the WHOLE accumulated answer every ~50ms, so perceived
 * smoothness is a function of how long the provider takes overall, not of chunk size.
 * A provider that finishes a few hundred words in well under a second therefore lands
 * the entire answer in one or two flushes: the text does not stream, it appears, and
 * the stick-to-bottom pin jumps the viewport in one large step instead of gliding.
 * Slower providers never hit that because their own pace is already comfortable.
 *
 * Rather than tune per provider — which would need revisiting for every model added —
 * this caps the *reveal* rate and lets everything below the cap through untouched:
 *
 *   rate = min(MAX_CPS, BASE_CPS + backlog / CATCHUP_SECONDS)
 *
 * A provider streaming at or under `BASE_CPS` never accumulates a backlog, so its
 * output is revealed the same frame it arrives and its feel is unchanged. Above it, a
 * backlog forms and the rate rises with it, which is what bounds the lag: the backlog
 * settles where the reveal rate matches the arrival rate, roughly
 * `(arrival - BASE) * CATCHUP_SECONDS` characters, i.e. under a second behind even for
 * a very fast provider. Once the stream ends the remainder drains faster still, so a
 * finished answer is never left trickling.
 *
 * Only the DISPLAY copy is paced. The store keeps the full text, so persistence, what
 * is sent back to the model, and copy-to-clipboard are all unaffected.
 */

/**
 * Reveal floor, characters/second. Chosen to sit above the natural pace of a typical
 * direct provider so that the common case is a no-op rather than an added delay.
 */
export const SMOOTH_STREAM_BASE_CPS = 320;

/**
 * Safety valve only — NOT the thing that produces smoothness.
 *
 * Smoothness comes from the catch-up term below: draining a backlog of N characters
 * takes about `CATCHUP_SECONDS * ln(1 + N / (BASE_CPS * CATCHUP_SECONDS))`, so a
 * 4,000-character answer that arrives all at once still reveals over roughly two and a
 * half seconds no matter how fast it landed.
 *
 * This ceiling must therefore sit ABOVE any rate a provider can sustain. Set below it,
 * the reveal can never match arrival and the lag grows without bound — a long answer
 * from a fast provider would finish streaming visibly after the model had stopped.
 * 8,000 chars/sec is ~2,000 tokens/sec, far beyond any current provider.
 */
export const SMOOTH_STREAM_MAX_CPS = 8000;

/**
 * How aggressively the rate answers a growing backlog. Larger = smoother but further
 * behind; this value keeps the steady-state lag under about a second.
 */
const CATCHUP_SECONDS = 0.9;

/** After the stream ends there is nothing left to pace against, so drain quicker. */
const POST_END_SPEEDUP = 2.2;

const TICK_MS = 40;
/** Long answers re-render expensively, so pace them on a cheaper tick. */
const LONG_ANSWER_CHARS = 20_000;
const LONG_ANSWER_TICK_MS = 80;

/** Characters/second to reveal given how far behind we are. */
export function revealRateCps(backlog: number, isStreaming: boolean): number {
  if (backlog <= 0) return 0;
  const rate = Math.min(
    SMOOTH_STREAM_MAX_CPS,
    SMOOTH_STREAM_BASE_CPS + backlog / CATCHUP_SECONDS,
  );
  return isStreaming ? rate : rate * POST_END_SPEEDUP;
}

/** Next reveal index after `elapsedMs`, never past `total`. */
export function nextRevealCount(
  revealed: number,
  total: number,
  isStreaming: boolean,
  elapsedMs: number,
): number {
  if (revealed >= total) return total;
  const backlog = total - revealed;
  const step = Math.max(
    1,
    Math.round((revealRateCps(backlog, isStreaming) * elapsedMs) / 1000),
  );
  return Math.min(total, revealed + step);
}

/** Longest `<`…`>` we will hold back; beyond this a lone `<` is treated as text. */
const MAX_PARTIAL_TAG_LEN = 200;

/**
 * Pull the cut back so a prefix never ends INSIDE a half-written tag.
 *
 * The answer carries `<atlarix-…>` and `<think>` markup, and slicing mid-tag would
 * flash the fragment as literal text for a frame or two. Only an opener that actually
 * looks like a tag is held back, and only briefly — otherwise prose containing a stray
 * `<` would stall forever waiting for a `>` that never comes.
 */
export function safeRevealLength(content: string, revealed: number): number {
  const end = Math.min(revealed, content.length);
  if (end <= 0) return 0;
  const lastOpen = content.lastIndexOf("<", end - 1);
  if (lastOpen < 0) return end;
  const closed = content.indexOf(">", lastOpen);
  if (closed >= 0 && closed < end) return end; // tag completed before the cut
  if (end - lastOpen > MAX_PARTIAL_TAG_LEN) return end; // not a tag, just prose
  if (!/^<\/?[a-zA-Z]/.test(content.slice(lastOpen, lastOpen + 3))) return end;
  return lastOpen;
}

function prefersReducedMotion(): boolean {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return false;
  }
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * Display copy of `content`, revealed at a bounded rate while it grows.
 *
 * Returns `content` unchanged when pacing has caught up, when the message is not
 * streaming, or when the user asked for reduced motion — so nothing outside an
 * actively-growing answer is affected.
 */
export function useSmoothStreamedContent(
  content: string,
  isStreaming: boolean,
): string {
  const reduceMotion = useMemo(prefersReducedMotion, []);

  // Start fully revealed: only GROWTH is paced. Without this, remounting mid-stream
  // (virtualized list recycling a row, or reopening a chat) would retype an answer
  // the user has already read.
  const [revealed, setRevealed] = useState(() => content.length);

  const revealedRef = useRef(revealed);
  const contentRef = useRef(content);
  const streamingRef = useRef(isStreaming);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastTickRef = useRef(0);

  contentRef.current = content;
  streamingRef.current = isStreaming;

  const tickMs =
    content.length > LONG_ANSWER_CHARS ? LONG_ANSWER_TICK_MS : TICK_MS;

  useEffect(() => {
    if (reduceMotion) return;

    // Content replaced or truncated (message swapped, edit re-stream) — resync rather
    // than leaving `revealed` past the end.
    if (revealedRef.current > content.length) {
      revealedRef.current = content.length;
      setRevealed(content.length);
    }

    if (revealedRef.current >= content.length) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    if (timerRef.current) return; // already draining

    lastTickRef.current = Date.now();
    timerRef.current = setInterval(() => {
      const total = contentRef.current.length;
      const now = Date.now();
      const elapsed = Math.max(1, now - lastTickRef.current);
      lastTickRef.current = now;

      if (revealedRef.current > total) revealedRef.current = total;
      const next = nextRevealCount(
        revealedRef.current,
        total,
        streamingRef.current,
        elapsed,
      );
      if (next !== revealedRef.current) {
        revealedRef.current = next;
        setRevealed(next);
      }
      if (next >= total && timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }, tickMs);
  }, [content, isStreaming, reduceMotion, tickMs]);

  // Unmount only — the effect above owns start/stop while mounted.
  useEffect(
    () => () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    },
    [],
  );

  return useMemo(() => {
    if (reduceMotion) return content;
    if (revealed >= content.length) return content;
    return content.slice(0, safeRevealLength(content, revealed));
  }, [content, revealed, reduceMotion]);
}
