/**
 * Sessions that message each other (owner, 2026-10-06) — CLI and desktop app.
 *
 * One Atlarix session can list the other sessions running on this machine and
 * send one a message: a finding, a status, a handoff. Modelled on Claude Code's
 * cross-session messaging, with our own pieces:
 *
 *  - INBOX. Every Atlarix process that runs sessions listens on its own socket
 *    (`/tmp/atlarix-peer-<uid>-<pid>.sock`, chmod 0600; a named pipe on
 *    Windows), framed exactly like the Chrome bridge (bridge/framing.ts). Local
 *    only: nothing goes over the network.
 *  - REGISTRY. Live sessions are rows in `__atlarix_live_sessions` in the shared
 *    database (the CLI and the app already share it), refreshed on a heartbeat.
 *    Each row carries a random token; a sender must present it, so a process
 *    that can open the socket but cannot read the user's database cannot post.
 *  - DELIVERY. A message lands in the receiving chat's mid-turn queue
 *    (user-interjections.ts), wrapped in `<atlarix-peer-message from=… reply-to=…>`
 *    so the model and the UI know it is not the user. A busy session reads it at
 *    its next step; an idle one is woken (`chat:background-job-update` with
 *    status `peer_message`), and the app or CLI opens a turn with it.
 *  - RULES. Plain text only, capped; per-sender rate limit; identical repeats
 *    within 10 s dropped; the inbox can refuse everything (setting). A peer's
 *    message is never the user's approval — the system prompt says so, and the
 *    permission prompts still fire on the receiving side.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import log from "electron-log";
import { encodeFrame, FrameReader } from "@/lib/bridge/framing";
import { wrapPeerMessage } from "./peer-message";

const logger = log.scope("peers");

export const LIVE_SESSIONS_TABLE = "__atlarix_live_sessions";
export const PEER_HEARTBEAT_MS = 15_000;
export const PEER_STALE_MS = 45_000;
export const PEER_TEXT_CAP = 100_000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 12;
const DUPLICATE_WINDOW_MS = 10_000;

export type Surface = "cli" | "app";

export interface LocalSession {
  sessionId: string;
  chatId: number;
  name: string;
  workspace: string;
  /**
   * A CLI session that has no session row yet (one is made on its first
   * message): reachable anyway, under a placeholder id. Delivering to it makes
   * the real session first, and the message goes there.
   */
  materialize?: () => Promise<{ sessionId: string; chatId: number }>;
}

export interface PeerSessionRow {
  sessionId: string;
  name: string;
  workspace: string;
  surface: Surface;
  busy: boolean;
  pid: number;
}

interface PeerFrame {
  type: "peer-message";
  token: string;
  to: string;
  id: string;
  text: string;
  from: {
    sessionId: string;
    name: string;
    surface: Surface;
    workspace: string;
  };
}

export interface PeerHost {
  /** Is the chat mid-turn right now? */
  isBusy(chatId: number): boolean;
  /** Put the wrapped message in the chat's queue. */
  enqueue(chatId: number, id: string, text: string): void;
  /** Wake an idle chat so it opens a turn with what is queued. */
  wake(chatId: number): void;
  /** "accept" (default) or "refuse". */
  inbound(): "accept" | "refuse";
}

// ─── socket paths ────────────────────────────────────────────────────────────

export function peerSocketPath(
  platform: NodeJS.Platform = process.platform,
  pid: number = process.pid,
): string {
  if (platform === "win32") {
    return `\\\\.\\pipe\\atlarix-peer-${process.env.USERNAME ?? "user"}-${pid}`;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  // Short on purpose: macOS caps a socket path at 104 bytes (see bridgeSocketPath).
  return `/tmp/atlarix-peer-${uid}-${pid}.sock`;
}

// The message the model sees: lib/peers/peer-message.ts (renderer-safe).
export { wrapPeerMessage, parsePeerMessage } from "./peer-message";

// ─── this process: inbox + registry ──────────────────────────────────────────

type Sqlite = {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...a: unknown[]): unknown;
    all(...a: unknown[]): unknown[];
  };
};

const local = new Map<string, LocalSession>();
let token = "";
let server: net.Server | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let hostImpl: PeerHost | null = null;
let surface: Surface = "app";
let dbFn: (() => Sqlite | null) | null = null;
const recentBySender = new Map<string, number[]>();
const recentTexts = new Map<string, number>();

function ensureTable(db: Sqlite): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${LIVE_SESSIONS_TABLE} (
      session_id TEXT NOT NULL,
      pid INTEGER NOT NULL,
      host TEXT NOT NULL,
      socket TEXT NOT NULL,
      token TEXT NOT NULL,
      name TEXT NOT NULL,
      workspace TEXT NOT NULL,
      surface TEXT NOT NULL,
      busy INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (session_id, pid, host)
    )
  `);
}

function db(): Sqlite | null {
  try {
    return dbFn?.() ?? null;
  } catch {
    return null;
  }
}

function publish(): void {
  const d = db();
  if (!d || !server) return;
  try {
    ensureTable(d);
    const host = os.hostname();
    const now = Date.now();
    d.prepare(
      `DELETE FROM ${LIVE_SESSIONS_TABLE} WHERE pid = ? AND host = ?`,
    ).run(process.pid, host);
    const insert = d.prepare(
      `INSERT INTO ${LIVE_SESSIONS_TABLE}
       (session_id, pid, host, socket, token, name, workspace, surface, busy, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of local.values()) {
      insert.run(
        s.sessionId,
        process.pid,
        host,
        peerSocketPath(),
        token,
        s.name,
        s.workspace,
        surface,
        hostImpl?.isBusy(s.chatId) ? 1 : 0,
        now,
      );
    }
  } catch (e) {
    logger.debug(`publish failed: ${(e as Error).message}`);
  }
}

/** Start this process's inbox. Idempotent; failures leave messaging off, never the app. */
export async function startPeerInbox(opts: {
  surface: Surface;
  host: PeerHost;
  database: () => Sqlite | null;
}): Promise<void> {
  if (server) return;
  surface = opts.surface;
  hostImpl = opts.host;
  dbFn = opts.database;
  token = randomBytes(24).toString("hex");
  const socketPath = peerSocketPath();
  if (!socketPath.startsWith("\\\\"))
    await fs.promises.rm(socketPath, { force: true }).catch(() => {});
  const srv = net.createServer((socket) => accept(socket));
  srv.on("error", (err) => logger.warn(`inbox error: ${err.message}`));
  try {
    await new Promise<void>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(socketPath, () => {
        srv.off("error", reject);
        resolve();
      });
    });
  } catch (e) {
    logger.warn(
      `no inbox (messages from other sessions are off): ${(e as Error).message}`,
    );
    return;
  }
  if (!socketPath.startsWith("\\\\"))
    await fs.promises.chmod(socketPath, 0o600).catch(() => {});
  server = srv;
  // Remove this process's rows and socket file however it ends.
  process.once("exit", stopPeerInbox);
  publish();
  heartbeat = setInterval(publish, PEER_HEARTBEAT_MS);
  (heartbeat as { unref?: () => void }).unref?.();
  logger.log(`inbox on ${socketPath}`);
}

export function stopPeerInbox(): void {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  const d = db();
  try {
    d
      ?.prepare(`DELETE FROM ${LIVE_SESSIONS_TABLE} WHERE pid = ? AND host = ?`)
      .run(process.pid, os.hostname());
  } catch {
    /* closing */
  }
  server?.close();
  server = null;
  const p = peerSocketPath();
  if (!p.startsWith("\\\\")) fs.rmSync(p, { force: true });
}

/** A session this process runs (the CLI's one; the app's open ones). */
export function noteLiveSession(s: LocalSession): void {
  const prev = local.get(s.sessionId);
  local.set(s.sessionId, s);
  if (!prev || prev.name !== s.name || prev.chatId !== s.chatId) publish();
}

export function forgetLiveSession(sessionId: string): void {
  if (local.delete(sessionId)) publish();
}

export function localSessionIds(): string[] {
  return [...local.keys()];
}

export function localSession(
  sessionId: string | undefined,
): LocalSession | undefined {
  return sessionId ? local.get(sessionId) : undefined;
}

/** This process's surface, as other sessions see it. */
export function peerSurface(): Surface {
  return surface;
}

/** Is this process's inbox up (so other sessions can reach and reply to it)? */
export function peerInboxRunning(): boolean {
  return server != null;
}

function accept(socket: net.Socket): void {
  const reader = new FrameReader();
  socket.on("data", (chunk) => {
    let frames: unknown[];
    try {
      frames = reader.push(chunk);
    } catch {
      socket.destroy();
      return;
    }
    for (const f of frames) {
      void receive(f as PeerFrame).then((reply) => {
        if (!socket.destroyed) socket.write(encodeFrame(reply));
      });
    }
  });
  socket.on("error", () => socket.destroy());
  socket.setTimeout(30_000, () => socket.destroy());
}

/** Exported for tests. */
export async function receive(f: PeerFrame): Promise<{ ok: boolean; error?: string }> {
  if (!f || f.type !== "peer-message")
    return { ok: false, error: "unknown frame" };
  if (!token || f.token !== token)
    return { ok: false, error: "not authorised" };
  let target = local.get(f.to);
  if (!target || !hostImpl) return { ok: false, error: "no such session here" };
  if (hostImpl.inbound() === "refuse")
    return {
      ok: false,
      error: "that session does not accept messages from other sessions",
    };
  const text = typeof f.text === "string" ? f.text.trim() : "";
  if (!text) return { ok: false, error: "empty message" };
  if (text.length > PEER_TEXT_CAP)
    return { ok: false, error: `message over ${PEER_TEXT_CAP} characters` };

  const now = Date.now();
  const senderKey = `${f.from?.sessionId}->${f.to}`;
  const times = (recentBySender.get(senderKey) ?? []).filter(
    (t) => now - t < RATE_WINDOW_MS,
  );
  if (times.length >= RATE_MAX) {
    return {
      ok: false,
      error:
        "too many messages to this session just now — batch them into one or wait a minute",
    };
  }
  const dupKey = `${senderKey}\0${text}`;
  if ((recentTexts.get(dupKey) ?? 0) > now - DUPLICATE_WINDOW_MS) {
    return { ok: true }; // a repeat; already delivered
  }
  times.push(now);
  recentBySender.set(senderKey, times);
  recentTexts.set(dupKey, now);
  for (const [k, t] of recentTexts)
    if (t < now - DUPLICATE_WINDOW_MS) recentTexts.delete(k);

  hostImpl.enqueue(
    target.chatId,
    f.id || randomUUID(),
    wrapPeerMessage(f.from, text),
  );
  if (!hostImpl.isBusy(target.chatId)) hostImpl.wake(target.chatId);
  return { ok: true };
}

// ─── other sessions: list + send ─────────────────────────────────────────────

interface Row {
  session_id: string;
  pid: number;
  host: string;
  socket: string;
  token: string;
  name: string;
  workspace: string;
  surface: string;
  busy: number;
  last_seen: number;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function liveRows(): Row[] {
  const d = db();
  if (!d) return [];
  try {
    ensureTable(d);
    const host = os.hostname();
    const rows = d
      .prepare(
        `SELECT * FROM ${LIVE_SESSIONS_TABLE} WHERE last_seen > ? AND host = ?`,
      )
      .all(Date.now() - PEER_STALE_MS, host) as Row[];
    return rows.filter((r) => r.pid === process.pid || processAlive(r.pid));
  } catch {
    return [];
  }
}

/** Other sessions on this machine, newest first; `exclude` is the caller's own. */
export function listPeerSessions(exclude?: string): PeerSessionRow[] {
  const seen = new Set<string>();
  const out: PeerSessionRow[] = [];
  for (const r of liveRows().sort((a, b) => b.last_seen - a.last_seen)) {
    if (r.session_id === exclude || seen.has(r.session_id)) continue;
    seen.add(r.session_id);
    out.push({
      sessionId: r.session_id,
      name: r.name,
      workspace: r.workspace,
      surface: r.surface === "cli" ? "cli" : "app",
      busy: r.busy === 1,
      pid: r.pid,
    });
  }
  return out;
}

/**
 * Resolve `to` — a session id, a unique prefix of one (8+ chars), or a session
 * name (case-insensitive) — to one live row.
 */
export function resolvePeer(
  to: string,
  exclude?: string,
): { row: Row } | { error: string } {
  const want = to.trim();
  if (!want)
    return { error: "Say which session (its name or id, from list_sessions)." };
  const rows = liveRows().filter((r) => r.session_id !== exclude);
  const byId = rows.filter(
    (r) =>
      r.session_id === want ||
      (want.length >= 8 && r.session_id.startsWith(want)),
  );
  const byName = rows.filter(
    (r) => r.name.toLowerCase() === want.toLowerCase(),
  );
  const matches = byId.length ? byId : byName;
  const distinct = [...new Map(matches.map((r) => [r.session_id, r])).values()];
  if (distinct.length === 0)
    return {
      error: `No live session named or numbered "${want}". list_sessions shows the ones running now.`,
    };
  if (distinct.length > 1) {
    return {
      error:
        `Several sessions match "${want}": ` +
        distinct
          .map(
            (r) =>
              `${r.name} (${r.session_id.slice(0, 8)}, ${r.surface}, ${r.workspace})`,
          )
          .join("; ") +
        ". Use the id.",
    };
  }
  // The same session open in two processes: the busier, most recent one gets it.
  const best = matches
    .filter((r) => r.session_id === distinct[0]!.session_id)
    .sort((a, b) => b.busy - a.busy || b.last_seen - a.last_seen)[0]!;
  return { row: best };
}

/** Deliver a message to another session; resolves with the receiver's answer. */
export function sendPeerMessage(
  row: { socket: string; token: string; session_id: string },
  from: PeerFrame["from"],
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  const frame: PeerFrame = {
    type: "peer-message",
    token: row.token,
    to: row.session_id,
    id: randomUUID(),
    text,
    from,
  };
  return new Promise((resolve) => {
    const socket = net.connect(row.socket);
    const reader = new FrameReader();
    const finish = (r: { ok: boolean; error?: string }) => {
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(10_000, () =>
      finish({ ok: false, error: "that session did not answer" }),
    );
    socket.once("connect", () => socket.write(encodeFrame(frame)));
    socket.on("data", (chunk) => {
      try {
        const [reply] = reader.push(chunk) as Array<{
          ok: boolean;
          error?: string;
        }>;
        if (reply) finish(reply);
      } catch {
        finish({ ok: false, error: "garbled reply" });
      }
    });
    socket.once("error", (e) =>
      finish({
        ok: false,
        error: `could not reach that session (${e.message})`,
      }),
    );
  });
}

/** Test hook: reset module state. */
export function __resetPeersForTests(): void {
  stopPeerInbox();
  local.clear();
  recentBySender.clear();
  recentTexts.clear();
  hostImpl = null;
  dbFn = null;
  token = "";
}
