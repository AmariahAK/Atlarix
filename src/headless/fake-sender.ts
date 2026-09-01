/**
 * A `WebContents`-like sender that records every `chat:stream` message (the same
 * surface tests/infra/ipc.ts provides, but prod-side with no vitest deps). The
 * headless runner reads `sends` to drive auto-approval and detect completion.
 */
export interface RecordedSend {
  channel: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
}

interface Waiter {
  channel: string;
  pred?: (payload: unknown) => boolean;
  resolve: (send: RecordedSend) => void;
}

export interface FakeSender {
  /** Pass as the `event` to a `chat:stream` handler invocation. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  event: any;
  sends: RecordedSend[];
  waitFor(
    channel: string,
    pred?: (payload: unknown) => boolean,
    timeoutMs?: number,
  ): Promise<RecordedSend>;
}

/**
 * @param onSend Called synchronously for every send, in arrival order, BEFORE any
 *   waiter is resolved. The trajectory writer uses this to stream each event
 *   straight to disk — see `trajectory-writer.ts` for why buffering is not an
 *   option. Keep any implementation write-through and O(1): `sends` already
 *   retains everything, and a second accumulator here would double that cost on a
 *   multi-hour run. Must not throw; a throwing callback would abort the send.
 */
export function makeFakeSender(onSend?: (send: RecordedSend) => void): FakeSender {
  const sends: RecordedSend[] = [];
  const waiters: Waiter[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const record = (channel: string, payload: any) => {
    const send: RecordedSend = { channel, payload };
    sends.push(send);
    onSend?.(send);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (w.channel === channel && (!w.pred || w.pred(payload))) {
        waiters.splice(i, 1);
        w.resolve(send);
      }
    }
  };

  const sender = {
    isDestroyed: () => false,
    isCrashed: () => false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    send: (channel: string, payload: any) => record(channel, payload),
  };

  return {
    event: { sender },
    sends,
    waitFor: (channel, pred, timeoutMs = 600_000) => {
      const existing = sends.find(
        (s) => s.channel === channel && (!pred || pred(s.payload)),
      );
      if (existing) return Promise.resolve(existing);
      return new Promise<RecordedSend>((resolve, reject) => {
        const waiter: Waiter = { channel, pred, resolve };
        waiters.push(waiter);
        // A non-finite timeout means "wait as long as it takes" — the caller's
        // orchestrator owns the deadline. It must NOT be handed to setTimeout:
        // Node clamps any delay outside 1..2147483647 to 1ms, so `Infinity` fires
        // on the next tick and every run would report an instant timeout — the
        // exact opposite of what was asked for. Register the waiter, schedule
        // nothing. Handled here rather than per call site because both
        // headless-runner and auto-approve funnel through this function.
        if (!Number.isFinite(timeoutMs)) return;
        const t = setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) {
            waiters.splice(i, 1);
            reject(new Error(`waitFor("${channel}") timed out after ${timeoutMs}ms`));
          }
        }, timeoutMs);
        t.unref?.();
      });
    },
  };
}
