/**
 * A turn runs on its CHAT's model, effort and mode (15.11.1).
 *
 * The CLI and the editors always send their session's own (`modelOverride`,
 * `workModeOverride`, `effortOverride`). An app turn, and a turn the harness
 * starts for any chat (a finished job's wake, a scheduled self-wake), may not;
 * before 15.11.1 main then used the app's global selection, which was whatever
 * another chat picked last. Here the missing parts come from the chat's row, so
 * the global is only the default a NEW chat is stamped with.
 *
 * Explicit values always win. A custom slash command's `streamChatModeOverride`
 * keeps its meaning (the mode is not filled then).
 *
 * App only: the CLI and the editors keep their session's model, /effort and mode
 * in memory and send them, so a row stamped when their session began must not
 * override a later /effort there.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { chatSessions } from "@/db/schema";
import type { ChatStreamParams } from "@/ipc/ipc_types";
import { effortSettingsFor, parseSessionModel } from "@/lib/session-choices";
import { WorkModeSchema } from "@/lib/schemas";

export async function fillTurnChoicesFromSession(req: ChatStreamParams): Promise<void> {
  if (process.env.ATLARIX_SURFACE === "cli") return;
  // A continue / redo turn names no session; its chat's transport knows it.
  let sessionId = req.workspaceSessionId;
  if (!sessionId) {
    const { sessionForTransport } = await import("@/lib/chat/stream-transport");
    sessionId = sessionForTransport(req.chatId);
  }
  if (!sessionId) return;
  if (req.modelOverride && req.workModeOverride && req.effortOverride) return;
  let row: { model: string | null; workMode: string | null } | undefined;
  try {
    row = await db.query.chatSessions.findFirst({
      where: eq(chatSessions.id, sessionId),
      columns: { model: true, workMode: true },
    });
  } catch {
    return; // no row readable: the app's defaults, as before
  }
  if (!row) return;
  const model = parseSessionModel(row.model);
  if (model && !req.modelOverride) {
    req.modelOverride = { provider: model.provider, name: model.name };
  }
  // Its effort travels with it: when the turn runs on the chat's model (a turn
  // that names another one, "try with a stronger model", keeps the app's).
  if (
    model &&
    !req.effortOverride &&
    req.modelOverride?.provider === model.provider &&
    req.modelOverride?.name === model.name
  ) {
    req.effortOverride = effortSettingsFor(model);
  }
  if (!req.workModeOverride && req.streamChatModeOverride == null) {
    const mode = WorkModeSchema.safeParse(row.workMode);
    // None stored (a chat from before, or one a CLI made): the app's mode at the upgrade.
    const { legacyChatWorkMode } = await import("@/main/backfill-session-choices");
    const { readSettings } = await import("@/main/settings");
    const fallback = mode.success ? mode.data : legacyChatWorkMode(readSettings);
    if (fallback) req.workModeOverride = fallback;
  }
}
