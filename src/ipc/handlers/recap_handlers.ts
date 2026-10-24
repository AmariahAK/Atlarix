import log from "electron-log";
import { createLoggedHandler } from "./safe_handle";

const logger = log.scope("recap_ipc");
const handle = createLoggedHandler(logger);

/**
 * The session recap for the app (lib/recap). The renderer decides WHEN (the
 * same rules as every surface) and sends the conversation it already shows;
 * main writes the line on the chat's own model and route.
 */
export function registerRecapHandlers(): void {
  handle("recap:generate", async (_e, chatId: number, conversation: string, force?: boolean) => {
    const { generateRecap } = await import("@/lib/recap/recap");
    const { lastStreamRequest } = await import("./chat_stream/stream-state");
    const { readSettings } = await import("@/main/settings");
    const req = lastStreamRequest.get(chatId) as { modelOverride?: { provider: string; name: string } } | undefined;
    const model = req?.modelOverride ?? readSettings().selectedModel;
    const { recentChangedFiles } = await import("@/lib/recap/changed-files");
    const filesChanged = await recentChangedFiles({ chatId });
    const text = await generateRecap(String(conversation ?? "").slice(-60_000), {
      chatId,
      model,
      force: force === true,
      filesChanged,
    });
    return { text };
  });
}
