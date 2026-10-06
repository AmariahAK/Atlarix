import type { WebContents } from "electron";
import log from "electron-log";

/**
 * Sends an IPC message to the renderer only if the provided `WebContents` is
 * still alive. This prevents `Object has been destroyed` errors that can occur
 * when asynchronous callbacks attempt to communicate after the window has
 * already been closed (e.g. during e2e test teardown).
 *
 * Before sending anything about a chat, it first sends that chat's held
 * coalesced update (see safeSendCoalesced), so the receiver sees events in the
 * order they happened: a held "content so far" never lands after the full
 * message list or the end of the turn.
 */
export function safeSend(
  sender: WebContents | null | undefined,
  channel: string,
  ...args: unknown[]
): void {
  if (!isAlive(sender)) return;
  const key = chatKey(sender, args[0]);
  if (key) {
    flushCoalesced(key);
    if (channel === "chat:response:end" || channel === "chat:response:error") {
      coalesced.delete(key);
    }
  }
  rawSend(sender, channel, args);
}

/**
 * Like safeSend, for updates where only the latest matters (the live text of a
 * streaming reply). At most one is sent per `windowMs` per chat: the first goes
 * out at once, later ones inside the window replace each other, and the last is
 * sent when the window closes (or earlier, when anything else about the chat is
 * sent).
 *
 * `build` makes the payload when it is actually sent, so a payload that depends
 * on what the receiver last got (a delta) is computed against the right base.
 */
export function safeSendCoalesced(
  sender: WebContents | null | undefined,
  channel: string,
  chatId: number,
  build: () => unknown,
  windowMs = 50,
): void {
  if (!isAlive(sender)) return;
  const key = chatKey(sender, { chatId })!;
  const now = Date.now();
  let pending = coalesced.get(key);
  if (!pending) {
    pending = { sender, channel, data: undefined, timer: null, lastSentAt: 0 };
    coalesced.set(key, pending);
  }
  if (!pending.timer && now - pending.lastSentAt >= windowMs) {
    pending.lastSentAt = now;
    rawSend(sender, channel, [build()]);
    return;
  }
  pending.sender = sender;
  pending.channel = channel;
  pending.data = build;
  if (!pending.timer) {
    pending.timer = setTimeout(
      () => flushCoalesced(key),
      Math.max(0, windowMs - (now - pending.lastSentAt)),
    );
  }
}

interface PendingSend {
  sender: WebContents;
  channel: string;
  data: (() => unknown) | undefined;
  timer: ReturnType<typeof setTimeout> | null;
  lastSentAt: number;
}

const coalesced = new Map<string, PendingSend>();

function flushCoalesced(key: string): void {
  const pending = coalesced.get(key);
  if (!pending) return;
  if (pending.timer) clearTimeout(pending.timer);
  pending.timer = null;
  if (pending.data === undefined) return;
  const data = pending.data;
  pending.data = undefined;
  pending.lastSentAt = Date.now();
  if (isAlive(pending.sender))
    rawSend(pending.sender, pending.channel, [data()]);
}

function chatKey(sender: WebContents, data: unknown): string | null {
  const chatId = (data as { chatId?: unknown } | null | undefined)?.chatId;
  if (typeof chatId !== "number") return null;
  return `${(sender as { id?: number }).id ?? 0}:${chatId}`;
}

function isAlive(
  sender: WebContents | null | undefined,
): sender is WebContents {
  if (!sender) return false;
  if (sender.isDestroyed()) return false;
  // @ts-ignore – `isCrashed` exists at runtime but is not in the type defs
  if (typeof sender.isCrashed === "function" && sender.isCrashed())
    return false;
  return true;
}

function rawSend(sender: WebContents, channel: string, args: unknown[]): void {
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore – allow variadic args beyond `data`
    sender.send(channel, ...args);
  } catch (error) {
    log.debug(
      `safeSend: failed to send on channel "${channel}" because: ${(error as Error).message}`,
    );
  }
}
