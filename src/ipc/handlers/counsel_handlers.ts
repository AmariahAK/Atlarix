import { ipcMain } from "electron";
import log from "electron-log";
import * as Sentry from "@sentry/electron/main";
import { readSettings } from "@/main/settings";
import { captureSafe } from "@/main/lib/analytics";
import { safeSend } from "../utils/safe_sender";
import { runCounselPipeline } from "@/lib/counsel/counsel-runner";
import type { CounselMode } from "@/lib/counsel/counsel-session";
import type { CounselStartIpcPayload } from "../ipc_types";

const logger = log.scope("counsel-ipc");

/** At most one renderer-triggered counsel run per chat (new start aborts the previous). */
const activeCounselByChatId = new Map<number, AbortController>();

export function registerCounselHandlers(): void {
  ipcMain.handle("counsel:start", async (event, payload: CounselStartIpcPayload) => {
    if (!payload || typeof payload.chatId !== "number") {
      return { ok: false as const, reason: "invalid_chat_id" };
    }
    const q = (payload.question ?? "").trim();
    if (!q) {
      return { ok: false as const, reason: "question_required" };
    }
    const settings = readSettings();
    if (settings.counsel?.enabled === false) {
      return { ok: false as const, reason: "disabled" };
    }

    const chatId = payload.chatId;
    activeCounselByChatId.get(chatId)?.abort();
    const ac = new AbortController();
    activeCounselByChatId.set(chatId, ac);

    const sender = event.sender;
    const turnId = payload.turnId ?? `counsel-ipc-${Date.now()}`;
    const mode: CounselMode = payload.mode === "workspace" ? "workspace" : "general";

    void (async () => {
      try {
        captureSafe("counsel_triggered", {
          trigger_type: "user_command",
          chat_mode: settings.selectedChatMode ?? "unknown",
          has_workspace: mode === "workspace",
        });
        await runCounselPipeline({
          chatId,
          turnId,
          trigger: "user_command",
          mode,
          question: q,
          settings,
          abortSignal: ac.signal,
          toolActivity: { webContents: sender, chatId },
          sendActivity: (p) => {
            safeSend(sender, "chat:activity", p);
            safeSend(sender, "counsel:participant-update", {
              chatId,
              turnId,
              activity: p,
            });
          },
        });
        if (ac.signal.aborted) {
          safeSend(sender, "counsel:complete", {
            ok: false,
            chatId,
            turnId,
            cancelled: true,
          });
          return;
        }
        safeSend(sender, "counsel:complete", {
          ok: true,
          chatId,
          turnId,
        });
      } catch (e) {
        const cancelled = ac.signal.aborted;
        logger.warn("[counsel:start] pipeline error:", e);
        try {
          Sentry.captureException(e, { tags: { feature: "counsel" } });
        } catch {
          /* noop */
        }
        safeSend(sender, "counsel:complete", {
          ok: false,
          chatId,
          turnId,
          cancelled,
          error: cancelled ? undefined : String(e),
        });
      } finally {
        if (activeCounselByChatId.get(chatId) === ac) {
          activeCounselByChatId.delete(chatId);
        }
      }
    })();

    return { ok: true as const, turnId };
  });

  ipcMain.handle("counsel:cancel", async (_event, chatId: number) => {
    if (typeof chatId !== "number") {
      return { ok: false as const, reason: "invalid_chat_id" };
    }
    const ac = activeCounselByChatId.get(chatId);
    if (!ac) {
      return { ok: false as const, reason: "no_active_session" };
    }
    ac.abort();
    activeCounselByChatId.delete(chatId);
    return { ok: true as const };
  });
}
