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

/** "editor": a session an IDE hosts over ACP (`atlarix acp`, src/cli/acp). */
export type Surface = "cli" | "app" | "chrome" | "editor";

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
  /** Earlier names and ids it answered to (a placeholder's, a title before an auto-title). */
  aliases?: string[];
  /** Published as this surface instead of the process's own (a browser this process speaks for). */
  surface?: Surface;
  /** The model it runs on, as people see it, for list_sessions (item 9). */
  model?: string;
  /** How its latest turn here ended, for another session's `result_of`. */
  lastTurn?: TurnRecord;
  /**
   * Hand the message on instead of queueing it in a chat here: a session this
   * process registers on behalf of something else (a browser behind the
   * bridge). Every check in `receive` still runs first; `chatId` is unused.
   */
  deliver?: (
    id: string,
    from: PeerFrame["from"],
    text: string,
  ) => Promise<{ ok: boolean; error?: string }>;
}

/** How a turn ended (lib/analytics/turn-end's outcome and error kind) and when. */
export interface TurnRecord {
  outcome: string;
  errorKind?: string;
  startedAt: number;
  endedAt: number;
}

export interface PeerSessionRow {
  sessionId: string;
  name: string;
  workspace: string;
  surface: Surface;
  busy: boolean;
  pid: number;
  /** Its mode (the stored one; Build when none was chosen) and model, when known (item 9). */
  mode?: string;
  model?: string;
}

interface PeerFrame {
  /**
   * "steer" and "stop" are for a session this process is RUNNING a turn of,
   * sent by another surface showing the same session (it follows the turn):
   * the user's own words for that turn, or the user stopping it.
   */
  type: "peer-message" | "open-session" | "steer" | "stop";
  token: string;
  to: string;
  id: string;
  /** Optional when `set` is given: a change alone. */
  text: string;
  /** Set the session's mode and/or model from its next turn (item 9), and/or answer its plan (item 11). */
  set?: { mode?: string; model?: string; plan?: string; planText?: string };
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
  /**
   * Set a session's mode and/or model from its next turn (item 9), and/or
   * answer its plan (item 11). `notice` is the line it shows; `startTurn`, the
   * turn an approval starts (the plan's own Build).
   */
  applySettings?(
    target: { chatId: number; sessionId: string; name?: string },
    set: { mode?: string; model?: string; plan?: string; planText?: string },
    from: PeerFrame["from"],
  ): Promise<{ ok: boolean; error?: string; notice?: string; startTurn?: string }>;
  /**
   * Show this session here and carry on in it (a handoff from another surface).
   * Only the app implements it: a CLI cannot open a terminal for itself.
   */
  openSession?(sessionId: string): Promise<{ ok: boolean; error?: string }>;
  /** The user's words for the running turn, as if typed here mid-turn. */
  steer?(chatId: number, id: string, text: string): void;
  /** Stop the running turn, as the stop button here would. */
  stop?(chatId: number): void;
}

/** The row every process publishes for itself, so a handoff can find "the app" even with no session open. */
export const PROCESS_ROW_PREFIX = "__process__:";

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
/**
 * An idle session here waits for its next prompt to read a message (Zed,
 * JetBrains: the editor starts turns, not Atlarix), so the sender is told
 * that, not that it starts a turn (QA, ai-95).
 */
let idleMessagesWait: () => boolean = () => false;
/**
 * The model a session here runs on when it named none of its own: the app's
 * chats run on the app's selected model, so their lines showed no model (QA, ai-b8).
 */
let defaultModelLabel: () => string | undefined = () => undefined;
export function setDefaultModelLabel(label: () => string | undefined): void {
  defaultModelLabel = label;
}
export function setIdleMessagesWait(waits: () => boolean): void {
  idleMessagesWait = waits;
}
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
  try {
    db.exec(
      `ALTER TABLE ${LIVE_SESSIONS_TABLE} ADD COLUMN aliases TEXT NOT NULL DEFAULT '[]'`,
    );
  } catch {
    /* already there */
  }
  try {
    db.exec(`ALTER TABLE ${LIVE_SESSIONS_TABLE} ADD COLUMN model TEXT NOT NULL DEFAULT ''`);
  } catch {
    /* already there */
  }
  try {
    db.exec(`ALTER TABLE ${LIVE_SESSIONS_TABLE} ADD COLUMN last_turn TEXT NOT NULL DEFAULT ''`);
  } catch {
    /* already there */
  }
}

/**
 * Names follow the session's title, which is generated after its first message
 * and can be renamed; the name it had before stays an alias so a sender holding
 * the old one still reaches it.
 */
function refreshNames(d: Sqlite): void {
  const ids = [...local.values()]
    .filter((x) => !x.materialize && !x.deliver)
    .map((x) => x.sessionId);
  if (ids.length === 0) return;
  try {
    const rows = d
      .prepare(
        `SELECT id, title FROM chat_sessions WHERE id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(...ids) as Array<{ id: string; title: string | null }>;
    for (const r of rows) {
      const cur = local.get(r.id);
      const title = r.title?.trim();
      if (!cur || !title || isPlaceholderTitle(title) || title === cur.name)
        continue;
      cur.aliases = [...new Set([...(cur.aliases ?? []), cur.name])];
      cur.name = title;
    }
  } catch {
    /* no chat_sessions here (tests) */
  }
}

/** A title the app gives a session before it has a real one. */
export function isPlaceholderTitle(title: string): boolean {
  return /^(untitled|new chat|new conversation)( session)?$/i.test(
    title.trim(),
  );
}

/** Bring this process's session names up to date now (before a send, say). */
export function refreshLocalNames(): void {
  const d = db();
  if (d) refreshNames(d);
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
    refreshNames(d);
    const host = os.hostname();
    const now = Date.now();
    d.prepare(
      `DELETE FROM ${LIVE_SESSIONS_TABLE} WHERE pid = ? AND host = ?`,
    ).run(process.pid, host);
    const insert = d.prepare(
      `INSERT INTO ${LIVE_SESSIONS_TABLE}
       (session_id, pid, host, socket, token, name, workspace, surface, busy, last_seen, aliases, model, last_turn)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // This process itself: how a handoff reaches "the app" with nothing open.
    insert.run(
      `${PROCESS_ROW_PREFIX}${process.pid}`,
      process.pid,
      host,
      peerSocketPath(),
      token,
      surface === "app" ? "Atlarix app" : surface === "editor" ? "Atlarix in an editor" : "Atlarix CLI",
      "",
      surface,
      0,
      now,
      "[]",
      "",
      "",
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
        s.surface ?? surface,
        !s.deliver && hostImpl?.isBusy(s.chatId) ? 1 : 0,
        now,
        JSON.stringify(s.aliases ?? []),
        s.model ?? (s.deliver ? "" : (defaultModelLabel() ?? "")),
        s.lastTurn ? JSON.stringify(s.lastTurn) : "",
      );
    }
  } catch (e) {
    logger.debug(`publish failed: ${(e as Error).message}`);
  }
}

/**
 * Publish this process's rows now: a turn started or ended. On the heartbeat
 * alone, a surface following the session saw the turn up to 15 s late.
 */
export function publishPeerState(): void {
  publish();
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
  if (prev) {
    const aliases = new Set([...(prev.aliases ?? []), ...(s.aliases ?? [])]);
    if (prev.name !== s.name) aliases.add(prev.name);
    s = { ...s, aliases: [...aliases] };
  }
  // The model, kept: registering again (a rename, a reload) dropped it, and it
  // may have been told before the session was registered at all (QA A11).
  s = {
    ...s,
    model: s.model ?? prev?.model ?? modelsBeforeRegistration.get(s.sessionId),
    lastTurn: s.lastTurn ?? prev?.lastTurn,
  };
  modelsBeforeRegistration.delete(s.sessionId);
  local.set(s.sessionId, s);
  if (!prev || prev.name !== s.name || prev.chatId !== s.chatId || prev.model !== s.model) publish();
}

/** Models told for a session not registered yet (its registration is async). */
const modelsBeforeRegistration = new Map<string, string>();

/**
 * Sessions another running Atlarix process has open. Starting a session must
 * not reuse or prune one of these: an editor thread (ACP) holds its session
 * from the first moment, before it has any messages.
 */
export function sessionsHeldElsewhere(): Set<string> {
  return new Set(
    liveRows()
      .filter((r) => r.pid !== process.pid && !r.session_id.startsWith(PROCESS_ROW_PREFIX))
      .map((r) => r.session_id),
  );
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
export async function receive(
  f: PeerFrame,
): Promise<{ ok: boolean; error?: string; applied?: string; waits?: boolean }> {
  if (!f || !["peer-message", "open-session", "steer", "stop"].includes(f.type))
    return { ok: false, error: "unknown frame" };
  if (!token || f.token !== token)
    return { ok: false, error: "not authorised" };
  if (f.type === "open-session") {
    if (!hostImpl?.openSession) {
      return { ok: false, error: "this Atlarix cannot open sessions" };
    }
    return hostImpl.openSession(String(f.to ?? ""));
  }
  if (f.type === "steer" || f.type === "stop") return control(f);
  let target = local.get(f.to);
  // Not "sent": nothing here shows it, so nothing would read it (QA A2).
  if (!target || !hostImpl) return { ok: false, error: NOT_OPEN_HERE };
  if (hostImpl.inbound() === "refuse")
    return {
      ok: false,
      error: "that session does not accept messages from other sessions",
    };
  const text = typeof f.text === "string" ? f.text.trim() : "";
  const set = f.set && (f.set.mode || f.set.model || f.set.plan) ? f.set : null;
  if (!text && !set) return { ok: false, error: "empty message" };
  if (text.length > PEER_TEXT_CAP)
    return { ok: false, error: `message over ${PEER_TEXT_CAP} characters` };
  if (set && target.deliver)
    return { ok: false, error: "a browser session has no mode or model to set" };
  if (set && !hostImpl.applySettings)
    return { ok: false, error: "this Atlarix cannot set another session's mode or model" };
  // A reject says why: the reason reaches it as the message.
  if (set?.plan === "reject" && !text) return { ok: false, error: "a reject needs a message saying why" };

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
  // Everything the frame asks for: a plan answer is not a repeat of a bare message.
  const dupKey = [senderKey, text, set?.mode, set?.model, set?.plan, set?.planText].map((v) => v ?? "").join("\0");
  if ((recentTexts.get(dupKey) ?? 0) > now - DUPLICATE_WINDOW_MS) {
    return { ok: true }; // a repeat; already delivered
  }
  times.push(now);
  recentBySender.set(senderKey, times);
  for (const [k, t] of recentTexts)
    if (t < now - DUPLICATE_WINDOW_MS) recentTexts.delete(k);

  if (target.deliver) {
    try {
      return await target.deliver(f.id || randomUUID(), f.from, text);
    } catch (e) {
      return { ok: false, error: `not delivered: ${(e as Error).message}` };
    }
  }

  if (target.materialize) {
    // A CLI with no session row yet: make the session, and deliver there.
    try {
      const placeholder = target;
      const real = await placeholder.materialize!();
      local.delete(placeholder.sessionId);
      const made: LocalSession = local.get(real.sessionId) ?? {
        ...placeholder,
        ...real,
        materialize: undefined,
      };
      made.materialize = undefined;
      // A sender that found it as the placeholder must still reach it.
      made.aliases = [
        ...new Set([
          ...(made.aliases ?? []),
          placeholder.sessionId,
          placeholder.name,
        ]),
      ];
      target = made;
      local.set(target.sessionId, target);
      publish();
    } catch (e) {
      return {
        ok: false,
        error: `that session could not start: ${(e as Error).message}`,
      };
    }
  }

  // The change first: refused (a model not set up there), nothing is
  // delivered, so the sender learns it as one answer.
  let applied: { notice?: string; startTurn?: string } = {};
  if (set) {
    const r = await hostImpl.applySettings!(
      { chatId: target.chatId, sessionId: target.sessionId, name: target.name },
      set,
      f.from,
    );
    if (!r.ok) return { ok: false, error: r.error ?? "not changed" };
    applied = r;
  }
  // A repeat only once it went through: a refused one ("busy, answer when its
  // turn ends") retried is a new attempt, never "ok" with nothing done.
  recentTexts.set(dupKey, now);
  // An approval's build turn: the plan's own Build instruction, as the user's
  // Build sends it, never wrapped as a peer's words (item 11).
  if (applied.startTurn) hostImpl.enqueue(target.chatId, `${f.id || randomUUID()}-build`, applied.startTurn);
  if (text) {
    hostImpl.enqueue(
      target.chatId,
      f.id || randomUUID(),
      wrapPeerMessage(f.from, text),
    );
  }
  const idle = (text || applied.startTurn) && !hostImpl.isBusy(target.chatId);
  if (idle) hostImpl.wake(target.chatId);
  return {
    ok: true,
    ...(applied.notice ? { applied: applied.notice } : {}),
    ...(idle && idleMessagesWait() ? { waits: true } : {}),
  };
}

/**
 * Steer or stop a turn this process runs, for another surface following it.
 *
 * NOT RUNNING IS AN ANSWER, not a failure: a turn that ended between the
 * sender's check and this frame answers "not running", and the sender then
 * sends the message as its own turn, so it is never lost.
 *
 * Steer text is the USER's (typed in the other window), so it is queued as
 * their own mid-turn message, never wrapped as a peer's, and the per-sender rate
 * limit (which exists for agents messaging agents) does not apply.
 */
async function control(f: PeerFrame): Promise<{ ok: boolean; error?: string }> {
  const target = local.get(f.to);
  if (!target || target.deliver || !hostImpl) return { ok: false, error: "no such session here" };
  if (!hostImpl.isBusy(target.chatId)) return { ok: false, error: NOT_RUNNING };
  if (f.type === "stop") {
    if (!hostImpl.stop) return { ok: false, error: "this Atlarix cannot stop it" };
    hostImpl.stop(target.chatId);
    return { ok: true };
  }
  const text = typeof f.text === "string" ? f.text.trim() : "";
  if (!text) return { ok: false, error: "empty message" };
  if (text.length > PEER_TEXT_CAP) return { ok: false, error: `message over ${PEER_TEXT_CAP} characters` };
  if (!hostImpl.steer) return { ok: false, error: "this Atlarix cannot take it" };
  hostImpl.steer(target.chatId, f.id || randomUUID(), text);
  return { ok: true };
}

/** What `control` answers when the turn has already ended. */
export const NOT_RUNNING = "not running";

/** A session this process no longer shows (switched away from, or closed). */
export const NOT_OPEN_HERE =
  "that session is not open there any more; it is saved, and the user can reopen it (/resume or the app)";

// ─── other sessions: list + send ─────────────────────────────────────────────

interface Row {
  aliases?: string;
  model?: string;
  last_turn?: string;
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

function asSurface(s: string): Surface {
  return s === "cli" || s === "chrome" || s === "editor" ? s : "app";
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
  const rows = liveRows().sort((a, b) => b.last_seen - a.last_seen);
  const blank = blankSessions(rows.map((r) => r.session_id));
  const modes = storedModes(rows.map((r) => r.session_id));
  for (const r of rows) {
    if (r.session_id.startsWith(PROCESS_ROW_PREFIX)) continue;
    if (r.session_id === exclude || seen.has(r.session_id)) continue;
    // A chat opened and never used (the editor makes one on open) beside a
    // real one in the same place: offering both made the agent, or you, pick
    // between two "editor sessions" (QA H1). Alone, it stays: it may be the
    // only way to reach that window.
    if (
      blank.has(r.session_id) &&
      rows.some(
        (o) =>
          o.session_id !== r.session_id &&
          !blank.has(o.session_id) &&
          !o.session_id.startsWith(PROCESS_ROW_PREFIX) &&
          o.surface === r.surface &&
          o.workspace === r.workspace,
      )
    )
      continue;
    seen.add(r.session_id);
    out.push({
      sessionId: r.session_id,
      name: r.name,
      workspace: r.workspace,
      surface: asSurface(r.surface),
      busy: r.busy === 1,
      pid: r.pid,
      ...(r.surface !== "chrome" ? { mode: modes.get(r.session_id) ?? "build" } : {}),
      ...(r.model ? { model: r.model } : {}),
    });
  }
  return out;
}

/** The stored mode of each session (work_mode); a session with none runs in Build. */
function storedModes(ids: string[]): Map<string, string> {
  const d = db();
  if (!d || !ids.length) return new Map();
  try {
    return new Map(
      (
        d
          .prepare(`SELECT id, work_mode FROM chat_sessions WHERE id IN (${ids.map(() => "?").join(",")}) AND work_mode IS NOT NULL`)
          .all(...ids) as Array<{ id: string; work_mode: string }>
      ).map((r) => [r.id, r.work_mode]),
    );
  } catch {
    return new Map(); // no chat_sessions here (tests)
  }
}

/** Which of these sessions hold no messages yet. None when the database can't say. */
function blankSessions(ids: string[]): Set<string> {
  const d = db();
  if (!d || !ids.length) return new Set();
  try {
    const used = new Set(
      (
        d
          .prepare(
            `SELECT DISTINCT session_id FROM session_messages WHERE session_id IN (${ids.map(() => "?").join(",")})`,
          )
          .all(...ids) as Array<{ session_id: string }>
      ).map((r) => r.session_id),
    );
    return new Set(ids.filter((id) => !used.has(id)));
  } catch {
    return new Set(); // no session_messages here (tests)
  }
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
  const rows = liveRows().filter(
    (r) =>
      r.session_id !== exclude && !r.session_id.startsWith(PROCESS_ROW_PREFIX),
  );
  const byId = rows.filter(
    (r) =>
      r.session_id === want ||
      (want.length >= 8 && r.session_id.startsWith(want)),
  );
  const lower = want.toLowerCase();
  const byName = rows.filter((r) => r.name.toLowerCase() === lower);
  const byAlias = rows.filter((r) => {
    try {
      return (JSON.parse(r.aliases ?? "[]") as string[]).some(
        (a) => a.toLowerCase() === lower,
      );
    } catch {
      return false;
    }
  });
  const matches = byId.length ? byId : byName.length ? byName : byAlias;
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

/**
 * The other process running a turn of this session right now, if any: a live
 * row for it from another pid, marked busy. Then this process only FOLLOWS the
 * session (re-reads it, steers and stops that turn) until the turn ends.
 */
export function runningElsewhere(sessionId: string): PeerSessionRow | null {
  const row = runningRow(sessionId);
  return row
    ? {
        sessionId: row.session_id,
        name: row.name,
        workspace: row.workspace,
        surface: asSurface(row.surface),
        busy: true,
        pid: row.pid,
      }
    : null;
}

function runningRow(sessionId: string): Row | undefined {
  return liveRows()
    .filter((r) => r.session_id === sessionId && r.pid !== process.pid && r.busy === 1)
    .sort((a, b) => b.last_seen - a.last_seen)[0];
}

/** Send the user's words to the turn running elsewhere; `NOT_RUNNING` when it has ended. */
export function steerElsewhere(sessionId: string, text: string): Promise<{ ok: boolean; error?: string }> {
  return controlElsewhere(sessionId, "steer", text);
}

/** Stop the turn running elsewhere; `NOT_RUNNING` when it has ended. */
export function stopElsewhere(sessionId: string): Promise<{ ok: boolean; error?: string }> {
  return controlElsewhere(sessionId, "stop", "");
}

function controlElsewhere(
  sessionId: string,
  type: "steer" | "stop",
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  const row = runningRow(sessionId);
  if (!row) return Promise.resolve({ ok: false, error: NOT_RUNNING });
  return sendFrame(
    row.socket,
    {
      type,
      token: row.token,
      to: row.session_id,
      id: randomUUID(),
      text,
      from: { sessionId, name: "", surface, workspace: row.workspace },
    },
    "that session did not answer",
  );
}

/** Deliver a message to another session; resolves with the receiver's answer. */
export function sendPeerMessage(
  row: { socket: string; token: string; session_id: string },
  from: PeerFrame["from"],
  text: string,
  set?: PeerFrame["set"],
): Promise<{ ok: boolean; error?: string; applied?: string; waits?: boolean }> {
  // Delivering to a CLI's placeholder first creates its session (seconds).
  return sendFrame(
    row.socket,
    { type: "peer-message", token: row.token, to: row.session_id, id: randomUUID(), text, ...(set ? { set } : {}), from },
    "that session did not answer",
  );
}

/** A turn of a session this process runs ended: what another session's `result_of` reads. */
export function noteTurnEnded(
  chatId: number,
  end: { outcome: string; errorKind?: string },
  startedAt: number,
): void {
  for (const s of local.values()) {
    if (s.deliver || s.chatId !== chatId) continue;
    s.lastTurn = {
      outcome: end.outcome,
      ...(end.errorKind ? { errorKind: end.errorKind } : {}),
      startedAt,
      endedAt: Date.now(),
    };
  }
  publish();
}

/** The turn record a live row carries, if its process noted one. */
export function turnRecordOf(row: { last_turn?: string }): TurnRecord | null {
  if (!row.last_turn) return null;
  try {
    const t = JSON.parse(row.last_turn) as TurnRecord;
    return typeof t.outcome === "string" && typeof t.endedAt === "number" ? t : null;
  } catch {
    return null;
  }
}

/** A session's latest reply as saved, from `since` (ms) when given. */
export function latestReply(
  sessionId: string,
  since?: number,
): { content: string; status: string; at: number; snapshotTurnId: string | null } | null {
  const d = db();
  if (!d) return null;
  try {
    const [r] = d
      .prepare(
        `SELECT content, status, created_at, snapshot_turn_id FROM session_messages
         WHERE session_id = ? AND role = 'assistant' AND kind = 'message'
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .all(sessionId) as Array<{ content: string; status: string; created_at: number; snapshot_turn_id: string | null }>;
    if (!r) return null;
    const at = r.created_at * 1000; // drizzle `timestamp` columns hold seconds
    // A turn that failed before replying left no row: the one found is an
    // earlier turn's, which is not this turn's reply.
    if (since != null && at < since - 1000) return null;
    return { content: r.content, status: r.status, at, snapshotTurnId: r.snapshot_turn_id };
  } catch {
    return null; // no session_messages here (tests)
  }
}

/** The model a session of this process runs on, as people see it, for list_sessions (item 9). */
export function noteSessionModel(sessionId: string, label: string | undefined): void {
  const s = local.get(sessionId);
  if (!s) {
    if (label) modelsBeforeRegistration.set(sessionId, label);
    return;
  }
  if (s.model === label) return;
  s.model = label;
  publish();
}

/** One frame to another process's inbox, and its answer. */
function sendFrame(
  socketPath: string,
  frame: PeerFrame,
  timeoutError: string,
): Promise<{ ok: boolean; error?: string; applied?: string; waits?: boolean }> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    const reader = new FrameReader();
    const finish = (r: { ok: boolean; error?: string }) => {
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(30_000, () => finish({ ok: false, error: timeoutError }));
    socket.once("connect", () => socket.write(encodeFrame(frame)));
    socket.on("data", (chunk) => {
      try {
        const [reply] = reader.push(chunk) as Array<{ ok: boolean; error?: string; applied?: string; waits?: boolean }>;
        if (reply) finish(reply);
      } catch {
        finish({ ok: false, error: "garbled reply" });
      }
    });
    socket.once("error", (e) => finish({ ok: false, error: `could not reach that session (${e.message})` }));
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

// ─── handoff: continue a session in the app ──────────────────────────────────

/** The most recently seen running Atlarix app on this machine, if any. */
export function liveAppProcess(): {
  socket: string;
  token: string;
  session_id: string;
} | null {
  const row = liveRows()
    .filter(
      (r) => r.session_id.startsWith(PROCESS_ROW_PREFIX) && r.surface === "app",
    )
    .sort((a, b) => b.last_seen - a.last_seen)[0];
  return row
    ? { socket: row.socket, token: row.token, session_id: row.session_id }
    : null;
}

/** Ask the running app to open `sessionId` in a window and carry on there. */
export function requestOpenInApp(
  app: { socket: string; token: string },
  sessionId: string,
): Promise<{ ok: boolean; error?: string }> {
  return sendFrame(
    app.socket,
    {
      type: "open-session",
      token: app.token,
      to: sessionId,
      id: randomUUID(),
      text: "",
      from: { sessionId, name: "", surface, workspace: "" },
    },
    "the app did not answer",
  );
}
