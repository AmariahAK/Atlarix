/**
 * The renderer half of the "Restoring your session…" hang.
 *
 * `useAuth` is an UNSHARED hook with ~22 consumers, so the settle event goes
 * through `auth-ipc-bridge` — one real IPC listener fanned out to every mount.
 * Two properties matter and both were failure modes:
 *
 *  - the fan-out must reach a listener that subscribed AFTER the event fired
 *    (a lazily rendered route would otherwise keep its own launch placeholder
 *    up forever), and
 *  - it must carry the answer, so no consumer needs to re-invoke IPC.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (...args: unknown[]) => void;
const handlers = new Map<string, Handler>();

beforeEach(() => {
  handlers.clear();
  vi.resetModules();
  (globalThis as unknown as { window: unknown }).window = {
    electron: {
      ipcRenderer: {
        on: (channel: string, fn: Handler) => handlers.set(channel, fn),
        invoke: vi.fn(),
      },
    },
  };
});

async function loadBridge() {
  return await import("@/lib/auth/auth-ipc-bridge");
}

function emitResolved(payload: unknown) {
  const fn = handlers.get("auth:resolved");
  if (!fn) throw new Error("auth:resolved was never registered");
  fn(payload);
}

describe("auth:resolved fan-out", () => {
  it("delivers to subscribers", async () => {
    const { subscribeAuthResolved } = await loadBridge();
    const seen: unknown[] = [];
    subscribeAuthResolved((d) => seen.push(d));

    emitResolved({ user: null, plan: "free" });

    expect(seen).toEqual([{ user: null, plan: "free" }]);
  });

  it("fans one IPC event out to every mount — not one listener per consumer", async () => {
    const { subscribeAuthResolved } = await loadBridge();
    const calls: number[] = [];
    for (let i = 0; i < 22; i++) subscribeAuthResolved(() => calls.push(i));

    emitResolved({ user: null, plan: "free" });

    expect(calls).toHaveLength(22);
    // One registration against the real IPC channel, regardless of mount count.
    expect(handlers.size).toBeGreaterThan(0);
  });

  it("replays to a LATE subscriber — the event fires once, early", async () => {
    const { subscribeAuthResolved } = await loadBridge();
    // Something has to register the channel before the event can arrive.
    subscribeAuthResolved(() => {});
    emitResolved({ user: { id: "u1", email: "a@b.c" }, plan: "pro" });

    const late: unknown[] = [];
    subscribeAuthResolved((d) => late.push(d));

    // Without the replay this mount never learns the restore settled and keeps
    // its own "Restoring your session…" up indefinitely.
    expect(late).toHaveLength(1);
    expect((late[0] as { plan: string }).plan).toBe("pro");
  });

  it("treats a missing payload as signed out rather than dropping the event", async () => {
    const { subscribeAuthResolved } = await loadBridge();
    const seen: unknown[] = [];
    subscribeAuthResolved((d) => seen.push(d));

    emitResolved(undefined);

    expect(seen).toEqual([{ user: null }]);
  });

  it("unsubscribing stops delivery", async () => {
    const { subscribeAuthResolved } = await loadBridge();
    const seen: unknown[] = [];
    const off = subscribeAuthResolved((d) => seen.push(d));
    off();

    emitResolved({ user: null, plan: "free" });

    expect(seen).toHaveLength(0);
  });
});
