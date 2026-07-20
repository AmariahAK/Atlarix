/**
 * Best-effort persistence for permission *preferences* ("always allow" rules).
 *
 * Persisting a preference is bookkeeping — it must NEVER block the actual
 * approval/command. A disk/DB failure here (classically `SQLITE_CANTOPEN` when
 * the disk is full and SQLite can't create its rollback journal, or a raw
 * `ENOSPC`) is logged and, if it looks like a storage-capacity problem, surfaced
 * once to the user — but the caller proceeds regardless. This mirrors the
 * graceful `[partial-draft]` upsert path in chat_stream/stream-lifecycle.ts and
 * the same best-effort stance opencode takes for its own bookkeeping writes
 * (session/revert.ts: `storage.write(...).pipe(Effect.ignore)`).
 */
import log from "electron-log";
import { showAgentNotification } from "@/main/agent-notification";

const logger = log.scope("permission-persist");

/**
 * True when the error looks like the disk/DB couldn't be written for capacity
 * reasons. `SQLITE_CANTOPEN` is how better-sqlite3 surfaces "the journal/DB file
 * couldn't be opened"; on an otherwise-healthy connection that almost always
 * means no free disk.
 */
export function isStorageCapacityError(e: unknown): boolean {
  const code = (e as { code?: string } | null | undefined)?.code ?? "";
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return (
    code === "SQLITE_CANTOPEN" ||
    code === "SQLITE_FULL" ||
    code === "ENOSPC" ||
    /unable to open database file|no space left|SQLITE_FULL|ENOSPC/i.test(msg)
  );
}

// Debounce so a burst of failed writes surfaces at most one OS notice per window.
let lastStorageWarningAt = 0;
const STORAGE_WARNING_DEBOUNCE_MS = 60_000;

/** Reset the debounce (tests only). */
export function __resetStorageWarningDebounce(): void {
  lastStorageWarningAt = 0;
}

function maybeWarnStorageFull(e: unknown): void {
  if (!isStorageCapacityError(e)) return;
  const now = Date.now();
  if (now - lastStorageWarningAt < STORAGE_WARNING_DEBOUNCE_MS) return;
  lastStorageWarningAt = now;
  void showAgentNotification(
    "Atlarix couldn't save to storage",
    "A write to the local database failed — your disk may be full. Free up space so settings and permissions can be saved.",
  );
}

/**
 * Run a preference-persisting write; never throw. On failure, warn (and show a
 * one-time storage-full notice if applicable) so the calling approval continues.
 */
export function persistPermissionPreferenceSafely(
  label: string,
  fn: () => void,
): void {
  try {
    fn();
  } catch (e) {
    logger.warn(`${label} failed (approval still proceeds):`, e);
    maybeWarnStorageFull(e);
  }
}
