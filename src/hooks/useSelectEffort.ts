/**
 * The one way to change /effort in the app: for the chat in front, with its
 * model (15.11.1, owner: effort per chat, stored with the model).
 *
 * One write: the app's settings take the model + level as what the next NEW
 * chat starts with, and main stores the same pair on this window's chat in
 * front. Written as a pair so neither holds one model's level against another.
 */
import { getDefaultStore } from "jotai";
import { useCallback } from "react";
import { activeSessionModelAtom, activeWorkspaceSessionIdAtom } from "@/atoms/sessionAtoms";
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
      // Optimistic; main stores the pair on this window's chat in front as it
      // writes the app's settings (`set-user-settings`, front-session.ts).
      if (store.get(activeWorkspaceSessionIdAtom)) {
        store.set(activeSessionModelAtom, {
          provider: model.provider,
          name: model.name,
          ...(model.customModelId != null ? { customModelId: model.customModelId } : {}),
          ...(patch.effort ? { effort: patch.effort } : {}),
          deepThinking: patch.deepThinking,
        });
      }
      await updateSettings({ selectedModel: model, ...patch });
    },
    [updateSettings],
  );
}
