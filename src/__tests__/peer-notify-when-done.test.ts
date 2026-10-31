/**
 * send_message's `notify_when_done` (lib/peers): ONE notice to the sender when
 * the turn that reads its message ends, saying how it ended and what it changed;
 * nothing when the message was refused or the session closed before running it.
 *
 * One process plays both ends over its real socket, as in peer-messaging.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  __resetPeersForTests,
  forgetLiveSession,
  noteLiveSession,
  noteTurnEnded,
  resolvePeer,
  sendPeerMessage,
  startPeerInbox,
  type PeerHost,
} from "@/lib/peers/peers";

const sqlite = new DatabaseSync(":memory:");
const queued: Array<{ chatId: number; id: string; text: string }> = [];
/** Ids still waiting in a chat's queue (the host's interjection queue). */
const pending = new Set<string>();
const woken: number[] = [];
let inbound: "accept" | "refuse" = "accept";

const host: PeerHost = {
  isBusy: () => false,
  enqueue: (chatId, id, text) => void queued.push({ chatId, id, text }),
  wake: (chatId) => void woken.push(chatId),
  inbound: () => inbound,
  pending: (_chatId, id) => pending.has(id),
};

const SENDER = { sessionId: "sess-sender-0001", chatId: -1, name: "lead", workspace: "/w/a" };
const from = { sessionId: SENDER.sessionId, name: SENDER.name, surface: "cli" as const, workspace: SENDER.workspace };

let n = 0;
/** A fresh target session per test, so no watch or repeat check carries over. */
function newTarget(): { sessionId: string; chatId: number; name: string; workspace: string } {
  n += 1;
  const t = { sessionId: `sess-target-${String(n).padStart(4, "0")}`, chatId: -100 - n, name: `worker ${n}`, workspace: "/w/b" };
  noteLiveSession(t);
  return t;
}

function row(sessionId: string) {
  const r = resolvePeer(sessionId, SENDER.sessionId);
  if ("error" in r) throw new Error(r.error);
  return r.row;
}

const notices = () => queued.filter((q) => q.chatId === SENDER.chatId);
const settle = () => new Promise((r) => setTimeout(r, 150));

beforeAll(async () => {
  await startPeerInbox({ surface: "app", host, database: () => sqlite as never });
  noteLiveSession(SENDER);
});
afterAll(() => __resetPeersForTests());
beforeEach(() => {
  queued.length = 0;
  pending.clear();
  woken.length = 0;
  inbound = "accept";
});

describe("notify_when_done", () => {
  it("sends ONE notice when the turn that read the message ends: how it ended, what it changed", async () => {
    const t = newTarget();
    const r = await sendPeerMessage(row(t.sessionId), from, "fix the flaky test", undefined, { notify: true });
    expect(r).toMatchObject({ ok: true, notify: true });

    noteTurnEnded(t.chatId, { outcome: "error", errorKind: "rate_limit" }, Date.now() - 1000);
    await settle();
    expect(notices()).toHaveLength(1);
    const notice = notices()[0]!.text;
    expect(notice).toContain(`from="${t.name}"`);
    expect(notice).toContain(`${t.name}'s turn ended: failed (rate limit)`);
    expect(notice).toContain("Files changed: none.");

    // Its next turn is not this message's: nothing more.
    noteTurnEnded(t.chatId, { outcome: "done" }, Date.now());
    await settle();
    expect(notices()).toHaveLength(1);
  });

  it("waits while the message is still queued (the turn ended before taking it)", async () => {
    const t = newTarget();
    await sendPeerMessage(row(t.sessionId), from, "after this turn, review it", undefined, { notify: true });
    const id = queued.find((q) => q.chatId === t.chatId)!.id;
    pending.add(id);

    noteTurnEnded(t.chatId, { outcome: "done" }, Date.now());
    await settle();
    expect(notices()).toHaveLength(0);

    pending.delete(id); // the next turn took it
    noteTurnEnded(t.chatId, { outcome: "done" }, Date.now());
    await settle();
    expect(notices()).toHaveLength(1);
    expect(notices()[0]!.text).toContain("turn ended: done");
  });

  it("says nothing when the message was refused", async () => {
    const t = newTarget();
    inbound = "refuse";
    const r = await sendPeerMessage(row(t.sessionId), from, "do it", undefined, { notify: true });
    expect(r.ok).toBe(false);
    expect(r.notify).toBeUndefined();
    noteTurnEnded(t.chatId, { outcome: "done" }, Date.now());
    await settle();
    expect(notices()).toHaveLength(0);
  });

  it("says nothing when the session closed before running it", async () => {
    const t = newTarget();
    await sendPeerMessage(row(t.sessionId), from, "do it later", undefined, { notify: true });
    forgetLiveSession(t.sessionId);
    noteLiveSession(t); // opened again: a fresh start, not the watched one
    noteTurnEnded(t.chatId, { outcome: "done" }, Date.now());
    await settle();
    expect(notices()).toHaveLength(0);
  });

  it("the 'turn ended' notice does not wake the idle sender (read at its next real turn)", async () => {
    const t = newTarget();
    await sendPeerMessage(row(t.sessionId), from, "do it", undefined, { notify: true });
    woken.length = 0;

    noteTurnEnded(t.chatId, { outcome: "done" }, Date.now());
    await settle();

    // The notice reached the sender's queue…
    expect(notices()).toHaveLength(1);
    // …but the sender was NOT woken — no full-context turn just to acknowledge.
    expect(woken).not.toContain(SENDER.chatId);
  });

  it("is opt-in, and the notice itself never asks for one back", async () => {
    const t = newTarget();
    const plain = await sendPeerMessage(row(t.sessionId), from, "just fyi");
    expect(plain.notify).toBeUndefined();
    noteTurnEnded(t.chatId, { outcome: "done" }, Date.now());
    await settle();
    expect(notices()).toHaveLength(0);

    await sendPeerMessage(row(t.sessionId), from, "now tell me", undefined, { notify: true });
    noteTurnEnded(t.chatId, { outcome: "done" }, Date.now());
    await settle();
    expect(notices()).toHaveLength(1);
    // The sender's turn reading the notice ends: the target hears nothing.
    const toTarget = queued.filter((q) => q.chatId === t.chatId).length;
    noteTurnEnded(SENDER.chatId, { outcome: "done" }, Date.now());
    await settle();
    expect(queued.filter((q) => q.chatId === t.chatId)).toHaveLength(toTarget);
  });
});
