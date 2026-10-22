/**
 * Whether the stored sessions changed, whoever changed them: another process
 * (the CLI, an editor's agent) writes the same database, and nothing tells this
 * one. A sessions list (the VS Code panel's Past chats, the app's sidebar and
 * tabs) re-reads when this moves (QA 4(b), item 6, 2026-10-22).
 *
 * One local read of every session's id, title and last change, hashed: a
 * title another process gave a session (an auto-title, a re-title after /undo)
 * moves it even when its length and the update time do not.
 */
export async function storedSessionsSignature(): Promise<string> {
  try {
    const { db } = await import("@/db");
    const { sql } = await import("drizzle-orm");
    const rows = db.all<{ id: string; title: string | null; u: number | null }>(
      sql`select id, title, updated_at as u from chat_sessions`,
    );
    // FNV-1a, 32-bit: cheap, and a collision only costs one missed refresh.
    let h = 0x811c9dc5;
    for (const r of rows) {
      const s = `${r.id}\u0000${r.title ?? ""}\u0000${r.u ?? 0}\u0001`;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
    }
    return `${rows.length}:${h >>> 0}`;
  } catch {
    return "";
  }
}

/** Call `onChange` when the signature moves; check every `intervalMs`. Returns stop. */
export function watchStoredSessions(
  onChange: () => void,
  opts: { intervalMs?: number; signature?: () => Promise<string> } = {},
): () => void {
  const signature = opts.signature ?? storedSessionsSignature;
  let last: string | null = null;
  let stopped = false;
  const tick = async () => {
    const sig = await signature();
    if (stopped || !sig) return;
    if (last !== null && sig !== last) onChange();
    last = sig;
  };
  void tick();
  const timer = setInterval(() => void tick(), opts.intervalMs ?? 3_000);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
