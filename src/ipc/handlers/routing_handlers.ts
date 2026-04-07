import { ipcMain } from "electron";
import { readSettings } from "../../main/settings";
import { runAutoRouterAsync } from "../../lib/routing/auto-router";

export function registerRoutingHandlers(): void {
  ipcMain.handle(
    "routing:preview",
    async (
      _event,
      params: { prompt: string }
    ): Promise<{
      category: string;
      targetModel: string;
      targetProvider: string;
    } | null> => {
      const settings = readSettings();
      if (!settings.autoModelRouting) return null;
      const providerId = settings.autoProviderId;
      const autoModelIds = settings.autoModelIds;
      if (!providerId || !Array.isArray(autoModelIds) || autoModelIds.length < 1) {
        return null;
      }
      const { decision } = await runAutoRouterAsync(params.prompt, settings, {
        agentMode: settings.agentMode ?? "guided",
        delegationRole: "main",
      });
      return {
        category: decision.category,
        targetModel: decision.targetModel,
        targetProvider: decision.targetProvider,
      };
    }
  );
}
