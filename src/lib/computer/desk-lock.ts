/**
 * One desktop, one action at a time.
 *
 * # Why the lock is GLOBAL and not per app
 *
 * The obvious design is a lock per target app, and it would be a lock that does not
 * cover the resource. Two reasons:
 *
 *  1. **The driver's snapshot cache is per (pid, window_id), but the DESKTOP is
 *     shared.** An act is a read-then-act pair — snapshot, resolve the token, act —
 *     and the driver's invariant is that a snapshot "is replaced by the next
 *     snapshot of the same window". Per-app locking makes that safe within one app
 *     and still lets two workers interleave across apps, which is fine for the
 *     cache and not fine for the second reason.
 *  2. **There is one focus and one cursor.** Raising a window, or typing into
 *     whatever is focused, is a global side effect. Two workers doing that
 *     concurrently produce input landing in the wrong place — and Atlarix runs up
 *     to five `task` workers per turn.
 *
 * cua-driver's own `type_text` has a `TextInputAdmission` mechanism against
 * concurrent typing, so it protects that one primitive. It does not protect
 * snapshot-then-act atomicity, which is what we need.
 *
 * # Why a FIFO chain and not `withLock`
 *
 * `ipc/utils/lock_utils.withLock` awaits only the ONE lock it observed, so with
 * three contenders B and C both wake when A releases and both acquire — it
 * serialises two callers, not N. `src/lib/plans/plan-artifacts.ts` documents that
 * exact bug and its fix, and this copies the fix. With five workers, "serialises
 * two" is the bug.
 *
 * # Bounded, not infinite
 *
 * A queue with no ceiling turns contention into a hang, and a hung turn is worse
 * than a refused one: the user sees nothing happening and the model learns nothing.
 * So there is a depth cap and a wait cap, and exceeding either returns a message
 * that tells the model to go and do something else.
 */
import log from "electron-log";

const logger = log.scope("computer-use");

/**
 * Anything past this many QUEUED callers is told to come back later.
 *
 * Counted as "in flight" — the holder plus everyone queued behind it — rather than
 * as "waiting", because a caller does not stop waiting until its gate resolves on a
 * microtask. The first version counted waiters and rejected the third queued caller
 * while the holder was still, technically, waiting: five workers arriving in one
 * synchronous burst is the normal case here, so that off-by-one was a real defect
 * and a test caught it.
 */
const MAX_WAITERS = 3;
const MAX_IN_FLIGHT = MAX_WAITERS + 1;
/** And no one waits longer than this. */
const MAX_WAIT_MS = 45_000;

/**
 * TWO CHAINS, NOT ONE — and the second one is not a performance tweak.
 *
 * The header's whole argument for a global lock is *"there is one focus and one
 * cursor"*. That argument is about the DESKTOP, and it does not reach the browser
 * tools: `browser_click` and `browser_type` drive a Chromium target over CDP, which
 * has its own input queue, does not move the system cursor and does not change which
 * window is frontmost. Serialising those behind a desktop act would be a lock that
 * covers more than the resource — the mirror of the mistake the header rejects — and
 * with `MAX_WAITERS = 3` it would also turn browser work into `DeskBusyError` for no
 * reason.
 *
 * Reads take no lane at all: they do not mutate, and the driver's own stale-token
 * mechanism is what makes a read-then-act pair safe.
 */
export type Lane = "desk" | "browser";

interface LaneState {
  /** The chain. */
  tail: Promise<unknown>;
  /** Admitted and not yet finished: the holder plus its queue. */
  inFlight: number;
  holder: string | null;
}

const lanes: Record<Lane, LaneState> = {
  desk: { tail: Promise.resolve(), inFlight: 0, holder: null },
  browser: { tail: Promise.resolve(), inFlight: 0, holder: null },
};

export class DeskBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeskBusyError";
  }
}

function busyMessage(state: LaneState, lane: Lane, wantedBy: string): string {
  const queued = Math.max(0, state.inFlight - 1);
  const what = lane === "browser" ? "the browser" : "the desktop";
  return (
    `Another agent is driving ${state.holder ? `"${state.holder}"` : what} right now and ` +
    `${queued} more are waiting, so ${wantedBy} was not touched. **Nothing was done.** ` +
    `Do other work first and come back to this — do not spin on it.`
  );
}

/**
 * Run `fn` with exclusive use of one lane.
 *
 * @param label what this action targets, for the busy message and the log
 * @param opts  `signal` is the turn's abort signal, so Stop unwinds the queue;
 *              `lane` defaults to the desktop.
 */
export async function withDesk<T>(
  label: string,
  fn: () => Promise<T>,
  opts?: { signal?: AbortSignal; lane?: Lane } | AbortSignal,
): Promise<T> {
  // The third argument used to be a bare AbortSignal and the tests still pass one.
  // Accepting both beats a flag day for a two-caller helper.
  const o = opts instanceof AbortSignal ? { signal: opts } : (opts ?? {});
  const signal = o.signal;
  const lane: Lane = o.lane ?? "desk";
  const state = lanes[lane];

  if (state.inFlight >= MAX_IN_FLIGHT) {
    throw new DeskBusyError(busyMessage(state, lane, label));
  }

  state.inFlight++;
  const previous = state.tail;

  // A deadline and an abort, raced against the queue. Without these a contended
  // desktop becomes a stalled turn.
  const gate = new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (fn2: () => void) => {
      if (settled) return;
      settled = true;
      fn2();
    };
    const timer = setTimeout(
      () => done(() => reject(new DeskBusyError(busyMessage(state, lane, label)))),
      MAX_WAIT_MS,
    );
    const onAbort = () =>
      done(() =>
        reject(new DeskBusyError(`Cancelled while waiting for the desktop (${label}).`)),
      );
    signal?.addEventListener("abort", onAbort, { once: true });
    // `.then(x, x)` so a previous holder's rejection cannot strand the queue.
    void previous.then(
      () =>
        done(() => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }),
      () =>
        done(() => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }),
    );
  });

  // Whatever happens to THIS caller, the chain must advance — otherwise one
  // rejected waiter blocks every later one.
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  state.tail = previous.then(
    () => held,
    () => held,
  );

  try {
    await gate;
  } catch (e) {
    state.inFlight--;
    release();
    throw e;
  }

  state.holder = label;
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    const ms = Date.now() - startedAt;
    if (ms > 5_000) logger.info(`[computer-use] held the ${lane} ${ms}ms for ${label}`);
    state.holder = null;
    state.inFlight--;
    release();
  }
}

/** Tests only. */
export function resetDeskLockForTests(): void {
  for (const state of Object.values(lanes)) {
    state.tail = Promise.resolve();
    state.inFlight = 0;
    state.holder = null;
  }
}

export function deskLockStateForTests(lane: Lane = "desk"): {
  inFlight: number;
  holder: string | null;
} {
  const { inFlight, holder } = lanes[lane];
  return { inFlight, holder };
}
