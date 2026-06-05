/**
 * Recording fake for `Electron.IpcMainInvokeEvent`.
 *
 * Every renderer-bound message in the stream handler goes through
 * `safeSend(event.sender, channel, payload)` (src/ipc/utils/safe_sender.ts),
 * which only needs `isDestroyed()` + `send()`. The recorded sends are the
 * assertion surface for tool sequences, permission events, phases and
 * stream end.
 */
export interface RecordedSend {
  channel: string;
  payload: any;
}

interface Waiter {
  channel: string;
  pred?: (payload: any) => boolean;
  resolve: (send: RecordedSend) => void;
}

export interface FakeIpcEvent {
  event: Electron.IpcMainInvokeEvent;
  sends: RecordedSend[];
  sentOn(channel: string): RecordedSend[];
  /**
   * Resolves with the first send on `channel` matching `pred` — including
   * ones recorded before the call. Use to react to permission / ask-user /
   * MCP-auth events mid-stream without guessing timing.
   */
  waitFor(
    channel: string,
    pred?: (payload: any) => boolean,
    timeoutMs?: number,
  ): Promise<RecordedSend>;
}

export function makeFakeIpcEvent(): FakeIpcEvent {
  const sends: RecordedSend[] = [];
  const waiters: Waiter[] = [];

  const record = (channel: string, payload: any) => {
    const send: RecordedSend = { channel, payload };
    sends.push(send);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i];
      if (waiter.channel === channel && (!waiter.pred || waiter.pred(payload))) {
        waiters.splice(i, 1);
        waiter.resolve(send);
      }
    }
  };

  const sender = {
    isDestroyed: () => false,
    isCrashed: () => false,
    send: (channel: string, payload: any) => record(channel, payload),
  };

  const event = { sender } as unknown as Electron.IpcMainInvokeEvent;

  return {
    event,
    sends,
    sentOn: (channel) => sends.filter((s) => s.channel === channel),
    waitFor: (channel, pred, timeoutMs = 20_000) => {
      const existing = sends.find(
        (s) => s.channel === channel && (!pred || pred(s.payload)),
      );
      if (existing) return Promise.resolve(existing);
      return new Promise<RecordedSend>((resolve, reject) => {
        const waiter: Waiter = { channel, pred, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) {
            waiters.splice(index, 1);
            reject(
              new Error(
                `waitFor("${channel}") timed out after ${timeoutMs}ms. ` +
                  `Recorded channels: ${[...new Set(sends.map((s) => s.channel))].join(", ") || "(none)"}`,
              ),
            );
          }
        }, timeoutMs).unref?.();
      });
    },
  };
}
