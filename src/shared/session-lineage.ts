/**
 * Where a chat came from, and the order a list of chats shows it in.
 *
 * A session can be started by another one: a /fork, a peer's message to a
 * session that had no row yet, an automation an agent set up. `chat_sessions`
 * keeps the chat it came from (`parent_session_id`) and how (`origin`, the JSON
 * below), and every list of past chats (the app, CLI /resume, the VS Code
 * panel, ACP session/list) shows a child under its parent, through
 * `orderSessionTree`.
 */

/** How a chat was started. "user": a new chat, not started by another one. */
export type SessionVia = "user" | "fork" | "peer" | "automation";

export interface SessionOrigin {
  via: SessionVia;
  /** The surface the chat was created on. */
  surface?: "app" | "cli" | "editor";
  /** The session that started it (`via: "peer"`), as it was named then. */
  by?: { sessionId: string; name: string; surface: string };
  /** The automation a run belongs to (`via: "automation"`). */
  automationId?: string;
}

/** What a new chat is stamped with when another one started it. */
export interface SessionLineage {
  parentSessionId: string;
  origin: Omit<SessionOrigin, "surface">;
}

const VIAS: ReadonlySet<string> = new Set(["user", "fork", "peer", "automation"]);
const SURFACES: ReadonlySet<string> = new Set(["app", "cli", "editor"]);

export function parseSessionOrigin(raw: string | null | undefined): SessionOrigin | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (!o || typeof o.via !== "string" || !VIAS.has(o.via)) return null;
    const by = o.by as Record<string, unknown> | undefined;
    return {
      via: o.via as SessionVia,
      ...(typeof o.surface === "string" && SURFACES.has(o.surface)
        ? { surface: o.surface as SessionOrigin["surface"] }
        : {}),
      ...(by && typeof by.sessionId === "string" && typeof by.name === "string"
        ? { by: { sessionId: by.sessionId, name: by.name, surface: String(by.surface ?? "") } }
        : {}),
      ...(typeof o.automationId === "string" ? { automationId: o.automationId } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * A lineage handed over IPC (sessions:start), checked: a parent id and a known
 * `via`, else nothing. The surface is never taken from the caller; the process
 * that writes the row stamps its own.
 */
export function parseSessionLineage(raw: unknown): SessionLineage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { parentSessionId, origin } = raw as { parentSessionId?: unknown; origin?: unknown };
  if (typeof parentSessionId !== "string" || !parentSessionId || parentSessionId.length > 200) return undefined;
  const parsed = parseSessionOrigin(JSON.stringify(origin ?? null));
  if (!parsed || parsed.via === "user") return undefined;
  const { surface: _ignored, ...rest } = parsed;
  return { parentSessionId, origin: rest };
}

export function serializeSessionOrigin(o: SessionOrigin): string {
  return JSON.stringify(o);
}

/**
 * Chats as a list shows them: each child right under its parent (`depth` 1, 2…),
 * newest first at every level, a tree placed by its most recently active
 * member, so work in a fork brings its tree up. A chat whose parent is not in
 * `rows` (another folder, deleted, or past a limit) is a root. `rootLimit`
 * keeps that many trees.
 */
export function orderSessionTree<T extends { id: string; parentSessionId: string | null; updatedAt: Date }>(
  rows: readonly T[],
  rootLimit?: number,
): Array<T & { depth: number }> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const r of rows) {
    const parent = r.parentSessionId && r.parentSessionId !== r.id ? byId.get(r.parentSessionId) : undefined;
    if (!parent) {
      roots.push(r);
      continue;
    }
    const list = children.get(parent.id) ?? [];
    list.push(r);
    children.set(parent.id, list);
  }

  const newest = new Map<string, number>();
  const newestOf = (r: T, seen: Set<string>): number => {
    const known = newest.get(r.id);
    if (known != null) return known;
    seen.add(r.id);
    let t = r.updatedAt.getTime();
    for (const c of children.get(r.id) ?? []) if (!seen.has(c.id)) t = Math.max(t, newestOf(c, seen));
    newest.set(r.id, t);
    return t;
  };
  const byNewest = (a: T, b: T) => newestOf(b, new Set()) - newestOf(a, new Set());

  const out: Array<T & { depth: number }> = [];
  const placed = new Set<string>();
  const walk = (r: T, depth: number) => {
    if (placed.has(r.id)) return;
    placed.add(r.id);
    out.push({ ...r, depth });
    for (const c of [...(children.get(r.id) ?? [])].sort(byNewest)) walk(c, depth + 1);
  };
  const sortedRoots = roots.sort(byNewest);
  for (const r of rootLimit != null ? sortedRoots.slice(0, rootLimit) : sortedRoots) walk(r, 0);
  // A parent loop (never written, but rows are data) has no root: list its
  // members as roots rather than lose them.
  const underARoot = new Set<string>();
  const mark = (r: T) => {
    if (underARoot.has(r.id)) return;
    underARoot.add(r.id);
    for (const c of children.get(r.id) ?? []) mark(c);
  };
  for (const r of roots) mark(r);
  for (const r of rows.filter((x) => !underARoot.has(x.id)).sort(byNewest)) walk(r, 0);
  return out;
}

/**
 * The few words a list row shows for where a chat came from, or null for a chat
 * the user started. A child under its parent says how ("fork"); one listed
 * apart from its parent also says which ("fork of <title>").
 */
export function lineageNote(r: {
  origin: SessionOrigin | null;
  depth?: number;
  runs?: number;
  parentTitle?: string;
}): string | null {
  const via = r.origin?.via;
  if (!via || via === "user") return null;
  const how =
    via === "fork"
      ? "fork"
      : via === "automation"
        ? `automation${(r.runs ?? 1) > 1 ? ` · ${r.runs} runs` : ""}`
        : `from ${r.origin?.by?.name || "another session"}`;
  if (!r.depth && r.parentTitle) return via === "fork" ? `fork of ${r.parentTitle}` : `${how} · in ${r.parentTitle}`;
  return how;
}

/** A row's title, indented under its parent. */
export function treeLabel(title: string, depth = 0): string {
  return depth > 0 ? `${"  ".repeat(depth - 1)}↳ ${title}` : title;
}

/**
 * `rows` (in `orderSessionTree` order) with the tree holding `id` moved to the
 * top, whole: the open chat comes first without leaving its parent or children.
 */
export function treeFirst<T extends { id: string; depth?: number }>(rows: readonly T[], id: string | null): T[] {
  const at = id ? rows.findIndex((r) => r.id === id) : -1;
  if (at < 0) return [...rows];
  let start = at;
  while (start > 0 && (rows[start].depth ?? 0) > 0) start--;
  let end = start + 1;
  while (end < rows.length && (rows[end].depth ?? 0) > 0) end++;
  return [...rows.slice(start, end), ...rows.slice(0, start), ...rows.slice(end)];
}
