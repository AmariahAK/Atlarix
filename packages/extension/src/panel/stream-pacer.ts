/**
 * Paces a streamed answer onto the screen at a rate the eye can follow.
 *
 * ══ THE PROBLEM THIS EXISTS FOR ══
 *
 * `onText` used to call `renderMarkdown(bubble, streamed)` once per delta, and
 * a delta is whatever size the provider happened to send. GLM-5.3 is fast and
 * chunky, so the panel got bursts of forty-odd characters several times a
 * second and each one rebuilt the entire message DOM. Watching it back, the
 * owner's description was that it "appears like its cutting and going" — text
 * teleporting in blocks rather than arriving.
 *
 * Note what is NOT wrong here: the model, the transport, and the answer. Only
 * the presentation. So the fix belongs in presentation and must not touch the
 * text that gets stored — `text` is always the whole thing received, whatever
 * is currently painted.
 *
 * ══ HOW IT PACES ══
 *
 * A backlog drained toward empty over a fixed window, rather than a fixed
 * characters-per-second rate. Each tick reveals
 *
 *     ceil(backlog × elapsed / TARGET_DRAIN_MS)
 *
 * which is self-correcting in both directions and is what makes one mechanism
 * serve a fast stream and a slow one:
 *
 *   - A SLOW stream never builds a backlog, so it is fully revealed within a
 *     few repaints. A floor of one character per repaint is what guarantees a
 *     small backlog terminates rather than shrinking by a fraction forever.
 *   - A FAST stream settles at a backlog of about rate x TARGET_DRAIN_MS: at
 *     1,600 chars/sec that is ~250 characters, painted smoothly and roughly
 *     160 ms behind. It CANNOT fall further behind, because a bigger backlog
 *     drains proportionally faster. That bound is the whole point.
 *
 * The decay is exponential, so the backlog approaches empty rather than
 * reaching it: the tail of one big burst, left alone, would animate for about
 * ln(backlog) x TARGET_DRAIN_MS. It is never left alone. The panel calls
 * `flush` at every point a turn can end, and that is by definition the moment
 * after the last delta arrived — so the tail is always cut, and what the pacer
 * has to guarantee mid-stream is the BOUND above, not a finish time.
 *
 * ══ WHY IT CANNOT GET STUCK ══
 *
 * `requestAnimationFrame` DOES NOT FIRE IN A BACKGROUND TAB. That has already
 * cost this codebase one shipped bug — `page-scripts/index.ts` built the
 * "Atlarix is working here" overlay at opacity 0 and faded it in from a frame
 * callback, so on a tab the user was not looking at it was created invisible
 * and every layer reported success. A pacer with the same assumption would
 * freeze an answer mid-sentence.
 *
 * Three independent guards, because this must not be the second instance:
 *
 *   1. The default scheduler arms a frame callback AND a timer, first to fire
 *      wins. Same belt-and-braces shape as the overlay fix.
 *   2. `push` notices when no tick has run for `STARVATION_MS` and paints
 *      everything immediately.
 *   3. `flush` paints the remainder unconditionally, and the panel calls it at
 *      every point a turn can end — completion, tool call, error, abort.
 *
 * Any one of them is enough on its own.
 */

/** How long after the last arrival the backlog should be empty. */
export const TARGET_DRAIN_MS = 160;

/**
 * Floor on the gap between repaints.
 *
 * Each repaint rebuilds the message's DOM (`renderMarkdown` clears and
 * re-parses), so this is the real cost knob. 25 ms is 40 fps — smooth for text
 * and a third less work than painting every frame. Skipping a frame does not
 * slow the reveal: the drain is computed from elapsed time, so a longer gap
 * reveals proportionally more.
 */
export const MIN_REPAINT_MS = 25;

/** No tick for this long means the scheduler is starved. Paint everything. */
export const STARVATION_MS = 500;

/** A tick that claims more than this was a suspended tab, not a slow frame. */
const MAX_TICK_MS = 100;

export interface PacerScheduler {
  now(): number;
  /** Run `fn` once, soon. Returns a cancel that must be safe to call twice. */
  frame(fn: () => void): () => void;
}

/**
 * Frame callback and timer together, whichever arrives first.
 *
 * The timer alone would be throttled to roughly 1 Hz in a background document;
 * the frame callback alone would not fire there at all. Together they degrade
 * to "slow" rather than to "stopped", and `push`'s starvation check covers even
 * that.
 */
const liveScheduler: PacerScheduler = {
  now: () => Date.now(),
  frame(fn) {
    let spent = false;
    const run = () => {
      if (spent) return;
      spent = true;
      fn();
    };
    const raf =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(run)
        : null;
    const timer = setTimeout(run, 32);
    return () => {
      spent = true;
      if (raf !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(raf);
      }
      clearTimeout(timer);
    };
  },
};

export class StreamPacer {
  private full = "";
  private shown = 0;
  private cancel: (() => void) | null = null;
  private lastTick = 0;

  /**
   * @param paint Called with the text to display. May be called with the same
   *   string twice; the panel's renderer is idempotent.
   */
  constructor(
    private readonly paint: (text: string) => void,
    private readonly sched: PacerScheduler = liveScheduler,
  ) {}

  /** Everything received, painted or not. This is the authoritative text. */
  get text(): string {
    return this.full;
  }

  /** True when the screen has caught up with what was received. */
  get settled(): boolean {
    return this.shown >= this.full.length;
  }

  push(delta: string): void {
    if (!delta) return;
    this.full += delta;
    const now = this.sched.now();
    if (this.cancel) {
      // Guard 2. Something is stopping ticks from running — a hidden panel, a
      // suspended window. Do not let the answer sit half-painted.
      if (now - this.lastTick > STARVATION_MS) this.paintAll(now);
      return;
    }
    this.lastTick = now;
    this.arm();
  }

  /** Paint everything now and stop. Safe to call when already settled. */
  flush(): void {
    this.disarm();
    if (!this.settled) this.paintAll(this.sched.now());
  }

  /** Drop the buffer without painting — for a round that is being discarded. */
  reset(): void {
    this.disarm();
    this.full = "";
    this.shown = 0;
  }

  private arm(): void {
    this.cancel = this.sched.frame(() => {
      this.cancel = null;
      this.tick();
    });
  }

  private disarm(): void {
    this.cancel?.();
    this.cancel = null;
  }

  private tick(): void {
    const now = this.sched.now();
    const backlog = this.full.length - this.shown;
    if (backlog <= 0) return; // Nothing owed: stay disarmed until the next push.

    const elapsed = now - this.lastTick;
    if (elapsed < MIN_REPAINT_MS) {
      // Too soon to be worth a DOM rebuild. `lastTick` is deliberately NOT
      // moved, so the next tick still measures from the last actual paint and
      // reveals what this frame would have.
      this.arm();
      return;
    }

    const dt = Math.min(elapsed, MAX_TICK_MS);
    const chars = Math.max(1, Math.ceil((backlog * dt) / TARGET_DRAIN_MS));
    this.shown = Math.min(this.full.length, this.shown + chars);
    this.lastTick = now;
    this.paint(this.full.slice(0, this.shown));
    if (!this.settled) this.arm();
  }

  private paintAll(now: number): void {
    this.shown = this.full.length;
    this.lastTick = now;
    this.paint(this.full);
  }
}
