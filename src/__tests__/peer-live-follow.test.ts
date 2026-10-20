/**
 * Live sessions across surfaces (PLAN-live-sessions-and-fork.md): a session is
 * live where its turn runs, and another surface showing it follows that turn.
 *
 * One process plays both ends over its real socket: a registry row for ANOTHER
 * live process (the test runner's parent) points at this process's own inbox,
 * so a steer or stop "sent elsewhere" comes back here through `receive`, with
 * the token check and everything after it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import {
  __resetPeersForTests,
  LIVE_SESSIONS_TABLE,
  NOT_RUNNING,
  noteLiveSession,
  receive,
  runningElsewhere,
  startPeerInbox,
  steerElsewhere,
  stopElsewhere,
  type PeerHost,
} from "@/lib/peers/peers";

const sqlite = new DatabaseSync(":memory:");
const busy = new Set<number>();
const steered: Array<{ chatId: number; text: string }> = [];
const stopped: number[] = [];
const queued: string[] = [];

const host: PeerHost = {
  isBusy: (chatId) => busy.has(chatId),
  enqueue: (_c, _id, text) => void queued.push(text),
  wake: () => {},
  inbound: () => "accept",
  steer: (chatId, _id, text) => void steered.push({ chatId, text }),
  stop: (chatId) => void stopped.push(chatId),
};

const SESSION = "sess-live-0001";
const OTHER_PID = process.ppid; // alive for as long as this test runs

/** Publish a row for SESSION as if another process ran it, reachable at this inbox. */
function rowElsewhere(isBusy: boolean): void {
  const me = sqlite
    .prepare(`SELECT socket, token FROM ${LIVE_SESSIONS_TABLE} WHERE pid = ? LIMIT 1`)
    .get(process.pid) as { socket: string; token: string };
  sqlite.prepare(`DELETE FROM ${LIVE_SESSIONS_TABLE} WHERE pid = ?`).run(OTHER_PID);
  sqlite
    .prepare(
      `INSERT INTO ${LIVE_SESSIONS_TABLE}
       (session_id, pid, host, socket, token, name, workspace, surface, busy, last_seen, aliases)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')`,
    )
    .run(SESSION, OTHER_PID, os.hostname(), me.socket, me.token, "Fix the parser", "/w/a", "cli", isBusy ? 1 : 0, Date.now());
}

beforeAll(async () => {
  await startPeerInbox({ surface: "app", host, database: () => sqlite as never });
  // This process holds the session too (it is where the frames land).
  noteLiveSession({ sessionId: SESSION, chatId: -3, name: "Fix the parser", workspace: "/w/a" });
});

afterAll(() => __resetPeersForTests());

beforeEach(() => {
  busy.clear();
  steered.length = 0;
  stopped.length = 0;
  queued.length = 0;
});

describe("which surface runs the turn", () => {
  it("another process, busy: that one runs it", () => {
    rowElsewhere(true);
    expect(runningElsewhere(SESSION)).toMatchObject({ sessionId: SESSION, surface: "cli", pid: OTHER_PID, busy: true });
  });

  it("another process, idle: nobody runs it, so this one may", () => {
    rowElsewhere(false);
    expect(runningElsewhere(SESSION)).toBeNull();
  });

  it("this process running it is not 'elsewhere'", () => {
    sqlite.prepare(`DELETE FROM ${LIVE_SESSIONS_TABLE} WHERE pid = ?`).run(OTHER_PID);
    busy.add(-3);
    expect(runningElsewhere(SESSION)).toBeNull();
  });
});

describe("steer and stop the turn running elsewhere", () => {
  it("the user's words reach the running turn as theirs, not wrapped as a peer's", async () => {
    rowElsewhere(true);
    busy.add(-3);
    const r = await steerElsewhere(SESSION, "also handle the empty file case");
    expect(r).toEqual({ ok: true });
    expect(steered).toEqual([{ chatId: -3, text: "also handle the empty file case" }]);
    expect(queued).toEqual([]); // not the peer-message path
  });

  it("no rate limit: it is one user typing, not an agent messaging an agent", async () => {
    rowElsewhere(true);
    busy.add(-3);
    for (let i = 0; i < 20; i++) expect((await steerElsewhere(SESSION, `note ${i}`)).ok).toBe(true);
    expect(steered).toHaveLength(20);
  });

  it("a turn that just ended says 'not running', so the sender sends it as its own turn", async () => {
    rowElsewhere(true); // the registry has not caught up yet
    const r = await steerElsewhere(SESSION, "too late?");
    expect(r).toEqual({ ok: false, error: NOT_RUNNING });
    expect(steered).toEqual([]);
  });

  it("nothing running anywhere: 'not running' without asking anyone", async () => {
    rowElsewhere(false);
    expect(await steerElsewhere(SESSION, "hello")).toEqual({ ok: false, error: NOT_RUNNING });
  });

  it("stop stops that turn", async () => {
    rowElsewhere(true);
    busy.add(-3);
    expect(await stopElsewhere(SESSION)).toEqual({ ok: true });
    expect(stopped).toEqual([-3]);
  });

  it("a frame without the token is refused", async () => {
    busy.add(-3);
    const r = await receive({
      type: "steer",
      token: "not-the-token",
      to: SESSION,
      id: "x",
      text: "hi",
      from: { sessionId: SESSION, name: "", surface: "cli", workspace: "" },
    } as never);
    expect(r).toEqual({ ok: false, error: "not authorised" });
    expect(steered).toEqual([]);
  });
});
