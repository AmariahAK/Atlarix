/**
 * The one way to change /effort in the app: for the chat in front, with its
 * model (15.11.1, owner: effort per chat, stored with the model).
 *
 * The app's settings take the same model + level too, as what the next NEW chat
 * starts with. Written as a pair so the default never holds one model's level
 * against another model.
 */
import { getDefaultStore } from "jotai";
import { useCallback } from "react";
import { activeSessionModelAtom, activeWorkspaceSessionIdAtom } from "@/atoms/sessionAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import { useSettings } from "@/hooks/useSettings";
import type { LargeLanguageModel } from "@/lib/schemas";

export function useSelectEffort(): (
  model: LargeLanguageModel,
  patch: { effort: string; deepThinking: boolean },
) => Promise<void> {
  const { updateSettings } = useSettings();
  return useCallback(
    async (model, patch) => {
      const store = getDefaultStore();
      const sessionId = store.get(activeWorkspaceSessionIdAtom);
      if (sessionId) {
        const choice = {
          provider: model.provider,
          name: model.name,
          ...(model.customModelId != null ? { customModelId: model.customModelId } : {}),
          ...(patch.effort ? { effort: patch.effort } : {}),
          deepThinking: patch.deepThinking,
        };
        store.set(activeSessionModelAtom, choice);
        void IpcClient.getInstance()
          .setWorkspaceSessionModel(sessionId, choice)
          .catch((e) => console.warn("[effort] failed to persist the chat's effort:", e));
      }
      await updateSettings({ selectedModel: model, ...patch });
    },
    [updateSettings],
  );
}
