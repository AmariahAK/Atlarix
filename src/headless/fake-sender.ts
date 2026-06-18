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

export function makeFakeSender(): FakeSender {
  const sends: RecordedSend[] = [];
  const waiters: Waiter[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const record = (channel: string, payload: any) => {
    const send: RecordedSend = { channel, payload };
    sends.push(send);
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
