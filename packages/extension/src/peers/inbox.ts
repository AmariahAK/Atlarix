/**
 * Tasks other Atlarix sessions handed to this browser (desktop
 * `lib/peers/chrome-peer.ts`), waiting for the user to open the panel.
 *
 * ══ WHY AN INBOX AND A BADGE, NOT A TURN ══
 *
 * The agent runs only in the side panel (agent/loop.ts), and Chrome opens the
 * panel only on a user gesture — nothing here can start work. So a delivery is
 * FILED: it lands here, the toolbar badge shows a count, and the user's click
 * on the Atlarix icon is what opens the panel and starts it. That click is also
 * the consent: another session asking is never the user agreeing.
 *
 * Imports only `shared/`, because the bridge (serve.ts) files into it and the
 * bridge must never reach the loop, the model client or the panel
 * (bridge-imports.test.ts).
 */
import { api } from "../shared/browser-api";

export interface PeerFrom {
  sessionId: string;
  name: string;
  /** "editor": an IDE's Atlarix thread (Zed, JetBrains) over ACP. */
  surface: "cli" | "app" | "chrome" | "editor";
  workspace: string;
}

export interface PeerTask {
  id: string;
  from: PeerFrom;
  text: string;
  at: number;
}

export const INBOX_KEY = "atlarix.peerInbox.v1";
export const INBOX_MAX = 10;
export const INBOX_TTL_MS = 24 * 60 * 60 * 1000;
/** The desktop caps a peer message at 100K characters; so does this side. */
export const PEER_TEXT_CAP = 100_000;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A delivery's args as a task, or null when they are not one. */
export function taskFromArgs(args: Record<string, unknown>, now = Date.now()): PeerTask | null {
  const f = (args.from ?? {}) as Record<string, unknown>;
  const text = str(args.text).trim();
  const id = str(args.id).trim();
  const from: PeerFrom = {
    sessionId: str(f.sessionId).trim(),
    name: str(f.name).trim() || "another session",
    surface: f.surface === "cli" || f.surface === "chrome" || f.surface === "editor" ? f.surface : "app",
    workspace: str(f.workspace),
  };
  if (!id || !text || !from.sessionId || text.length > PEER_TEXT_CAP) return null;
  return { id, from, text, at: now };
}

async function read(now: number): Promise<PeerTask[]> {
  try {
    const got = await api().storage.local.get(INBOX_KEY);
    const list = Array.isArray(got[INBOX_KEY]) ? (got[INBOX_KEY] as PeerTask[]) : [];
    return list.filter((t) => t && typeof t.id === "string" && now - t.at < INBOX_TTL_MS);
  } catch {
    return [];
  }
}

async function write(list: PeerTask[]): Promise<void> {
  await api().storage.local.set({ [INBOX_KEY]: list });
  await redrawBadge(list.length);
}

export async function listInbox(now = Date.now()): Promise<PeerTask[]> {
  return read(now);
}

/** File a task. Idempotent on id; the oldest go past INBOX_MAX. Returns how many wait. */
export async function addToInbox(task: PeerTask, now = Date.now()): Promise<number> {
  const list = await read(now);
  if (!list.some((t) => t.id === task.id)) list.push(task);
  const kept = list.slice(-INBOX_MAX);
  await write(kept);
  return kept.length;
}

/** The oldest waiting task, removed from the inbox; null when none waits. */
export async function takeFromInbox(now = Date.now()): Promise<PeerTask | null> {
  const list = await read(now);
  const first = list.shift() ?? null;
  await write(list);
  return first;
}

/** The toolbar badge: how many tasks wait. No permission needed. */
export async function redrawBadge(count?: number): Promise<void> {
  try {
    const n = count ?? (await read(Date.now())).length;
    const action = api().action;
    if (!action?.setBadgeText) return;
    await action.setBadgeText({ text: n > 0 ? String(n) : "" });
    if (n > 0) await action.setBadgeBackgroundColor?.({ color: "#10b981" });
  } catch {
    /* a badge is a nicety */
  }
}
