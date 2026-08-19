/**
 * Chat-scoped IPC registries deliver to EVERY subscriber, and an unsubscribe removes
 * only its own handler.
 *
 * `permissionHandlers`, `commandPermissionBlockedHandlers` and
 * `filePermissionBlockedHandlers` were `Map<number, handler>` — ONE slot per chat —
 * while `InlinePermissionApprovals` is rendered per ASSISTANT MESSAGE
 * (`AssistantMessageBody.tsx`), so a chat has as many live subscribers as it has
 * messages. `permission-request` additionally has a second, unrelated subscriber in
 * `useStreamChat`.
 *
 * Two things went wrong, and the second is the one that bit:
 *   1. `set()` meant last-registration-wins, so earlier subscribers stopped receiving.
 *   2. The unsubscribe returned to an OLD registration did `delete(chatId)` — removing
 *      whichever handler currently held the slot rather than its own. An unmounting
 *      message could therefore leave the chat with NO handler at all.
 *
 * Observed as a turn hanging indefinitely on an outside-workspace write: the
 * `sandbox_escalation` approval card never reached the screen, nothing could approve
 * it, and only Stop recovered.
 *
 * These tests exercise the registry semantics directly rather than through IpcClient,
 * which needs an Electron preload — the logic under test is the add/remove/notify
 * triple, and a naive `Set` refactor can still get the unsubscribe half wrong.
 */
import { describe, it, expect, vi } from "vitest";

/** Mirrors `addChatSubscriber` in src/ipc/ipc_client.ts. */
function addChatSubscriber<T>(
  registry: Map<number, Set<(payload: T) => void>>,
  chatId: number,
  handler: (payload: T) => void,
): () => void {
  let handlers = registry.get(chatId);
  if (!handlers) {
    handlers = new Set();
    registry.set(chatId, handlers);
  }
  handlers.add(handler);
  return () => {
    const set = registry.get(chatId);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) registry.delete(chatId);
  };
}

/** Mirrors `notifyChatSubscribers` in src/ipc/ipc_client.ts. */
function notifyChatSubscribers<T>(
  registry: Map<number, Set<(payload: T) => void>>,
  chatId: number,
  payload: T,
): boolean {
  const handlers = registry.get(chatId);
  if (!handlers || handlers.size === 0) return false;
  for (const handler of handlers) {
    try {
      handler(payload);
    } catch {
      /* isolated on purpose — see below */
    }
  }
  return true;
}

const CHAT = -2; // ephemeral chats use negative ids; the reported hang was chat -2

describe("chat-scoped subscriber registries", () => {
  it("delivers one event to every subscriber, not just the newest", () => {
    const reg = new Map<number, Set<(p: string) => void>>();
    const card = vi.fn();
    const proposals = vi.fn();
    addChatSubscriber(reg, CHAT, card);
    addChatSubscriber(reg, CHAT, proposals);

    expect(notifyChatSubscribers(reg, CHAT, "escalation")).toBe(true);
    expect(card).toHaveBeenCalledWith("escalation");
    expect(proposals).toHaveBeenCalledWith("escalation");
  });

  it("THE BUG: a later registration's unsubscribe must not silence the earlier one", () => {
    // The old code did `delete(chatId)`, so this sequence left the chat with nothing
    // listening — and the next approval card was never drawn.
    const reg = new Map<number, Set<(p: string) => void>>();
    const first = vi.fn();
    addChatSubscriber(reg, CHAT, first);
    const unsubSecond = addChatSubscriber(reg, CHAT, vi.fn());

    unsubSecond();

    expect(notifyChatSubscribers(reg, CHAT, "still-listening")).toBe(true);
    expect(first).toHaveBeenCalledWith("still-listening");
  });

  it("drops the chat entry only once the last subscriber leaves", () => {
    const reg = new Map<number, Set<(p: string) => void>>();
    const unsubA = addChatSubscriber(reg, CHAT, vi.fn());
    const unsubB = addChatSubscriber(reg, CHAT, vi.fn());

    unsubA();
    expect(reg.has(CHAT)).toBe(true); // B is still there
    unsubB();
    expect(reg.has(CHAT)).toBe(false); // now it can go
  });

  it("reports non-delivery so the empty case can be logged, not swallowed", () => {
    // This is what surfaces `[IPC] No permission handler for chat -2` — the line that
    // names the failure in one step when a turn is stuck waiting on a card.
    const reg = new Map<number, Set<(p: string) => void>>();
    expect(notifyChatSubscribers(reg, CHAT, "nobody-home")).toBe(false);

    const unsub = addChatSubscriber(reg, CHAT, vi.fn());
    unsub();
    expect(notifyChatSubscribers(reg, CHAT, "still-nobody")).toBe(false);
  });

  it("one throwing subscriber does not starve the others", () => {
    // These registries carry the approval card. A subscriber that throws must not
    // stop the card from rendering — that failure is indistinguishable from the hang.
    const reg = new Map<number, Set<(p: string) => void>>();
    addChatSubscriber(reg, CHAT, () => {
      throw new Error("boom");
    });
    const card = vi.fn();
    addChatSubscriber(reg, CHAT, card);

    expect(() => notifyChatSubscribers(reg, CHAT, "escalation")).not.toThrow();
    expect(card).toHaveBeenCalledWith("escalation");
  });

  it("keeps chats isolated from each other", () => {
    const reg = new Map<number, Set<(p: string) => void>>();
    const a = vi.fn();
    const b = vi.fn();
    addChatSubscriber(reg, -2, a);
    addChatSubscriber(reg, -3, b);

    notifyChatSubscribers(reg, -2, "for-a");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });
});
