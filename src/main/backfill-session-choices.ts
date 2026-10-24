/**
 * Every chat gets its own model + effort + mode, starting from today's defaults.
 *
 * Before 15.11.1 the app kept these app-wide, so a chat had no model of its own
 * and often no mode (`work_mode` NULL until the first pick inside it). Left so,
 * such a chat would keep following whatever another chat picked last. The owner's
 * rule (2026-10-24): existing chats start from the app's value at the time of the
 * upgrade.
 *
 * - **Model:** NULL rows get today's default model + effort. Only the app reads
 *   the column, so this is safe on every start; nothing picked is overwritten.
 * - **Mode:** rows are NOT touched. A CLI or editor session with no stored mode
 *   keeps its own on resume (and lists as Build), and nothing on a row says which
 *   surface made it. Today's mode is saved once instead (`legacyChatWorkMode`),
 *   and the app reads a NULL mode as that (`legacyChatWorkMode()` below).
 */
import log from "electron-log";
import { isNull } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { chatSessions } from "@/db/schema";
import {
  defaultSessionModel,
  defaultSessionWorkMode,
  serializeSessionModel,
} from "@/lib/session-choices";
import { WorkModeSchema, type UserSettings, type WorkMode } from "@/lib/schemas";

const logger = log.scope("session-choices");

type Db = BetterSQLite3Database<typeof schema>;

export function backfillSessionChoices(
  db: Db,
  settings: UserSettings,
  save: (patch: Partial<UserSettings>) => void,
): { model: number; legacyWorkMode: WorkMode | null } {
  const result: { model: number; legacyWorkMode: WorkMode | null } = {
    model: 0,
    legacyWorkMode: settings.legacyChatWorkMode ?? null,
  };
  try {
    if (!settings.legacyChatWorkMode) {
      result.legacyWorkMode = defaultSessionWorkMode(settings);
      save({ legacyChatWorkMode: result.legacyWorkMode });
    }
    const model = defaultSessionModel(settings);
    if (model) {
      result.model = db
        .update(chatSessions)
        .set({ model: serializeSessionModel(model) })
        .where(isNull(chatSessions.model))
        .run().changes;
    }
    if (result.model) {
      logger.info(`gave ${result.model} chat(s) the default model (per-chat choices, 15.11.1)`);
    }
  } catch (e) {
    // Never in the way of starting: an unfilled chat reads as the default anyway.
    logger.warn("backfill of per-chat model/mode failed (non-fatal):", e);
  }
  legacy = result.legacyWorkMode;
  return result;
}

let legacy: WorkMode | null | undefined;

/**
 * What an app chat with no stored mode runs in: the app's mode at the upgrade.
 * `null` in the CLI and the editors (they keep their own) and before it is saved.
 */
export function legacyChatWorkMode(read: () => Pick<UserSettings, "legacyChatWorkMode">): WorkMode | null {
  if (process.env.ATLARIX_SURFACE === "cli") return null;
  if (legacy === undefined) {
    const parsed = WorkModeSchema.safeParse(read().legacyChatWorkMode);
    legacy = parsed.success ? parsed.data : null;
  }
  return legacy;
}

/** Tests only. */
export function __resetLegacyChatWorkModeForTests(): void {
  legacy = undefined;
}
