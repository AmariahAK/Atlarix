/**
 * The one way to change the chat model.
 *
 * This body was copy-pasted in four places — `ModelPickerSheetContent`,
 * `CompactModelSearch`, `ModelsSection` and `LocalProviderModelSelector` (the
 * first two are now one component, `ModelPicker`) — each
 * doing `updateSettings({ selectedModel })` followed by an invalidation of
 * `TOKEN_COUNT_QUERY_KEY`. The invalidation is the part that is easy to forget and
 * silent when missed: the context meter keeps reporting the OLD model's budget until
 * something else happens to invalidate it, so the number beside the composer is
 * quietly wrong for a model the user can see they already switched away from.
 *
 * Four copies meant four chances to drift, and a fifth caller (the BYOK offer) would
 * have been a fifth. One writer instead.
 *
 * The analytics event is NOT fired here and must not be: `settings_handlers.ts`
 * already emits `ai_model_selected` in main by diffing the settings it is handed, so
 * it covers every writer automatically — including any that never goes through this
 * hook.
 */

import { getDefaultStore } from "jotai";
import { activeChatIdAtom, peerModelByChatIdAtom, selectedChatIdAtom } from "@/atoms/chatAtoms";
import { activeSessionModelAtom, activeWorkspaceSessionIdAtom } from "@/atoms/sessionAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useSettings } from "@/hooks/useSettings";
import { TOKEN_COUNT_QUERY_KEY } from "@/hooks/useCountTokens";
import type { LargeLanguageModel } from "@/lib/schemas";
import type { SessionModelChoice } from "@/lib/session-choices";

export function useSelectModel(): (model: LargeLanguageModel) => Promise<void> {
  const { updateSettings } = useSettings();
  const queryClient = useQueryClient();

  return useCallback(
    async (model: LargeLanguageModel) => {
      const store = getDefaultStore();
      // The chat in front runs on it from now on, and only that chat (15.11.1);
      // the app's selection below is what the next NEW chat starts with.
      // Optimistic, keeping its effort until main says which level the new model
      // keeps (a level only stays when the new model lists it too).
      const sessionId = store.get(activeWorkspaceSessionIdAtom);
      if (sessionId) {
        const was = store.get(activeSessionModelAtom);
        store.set(activeSessionModelAtom, {
          provider: model.provider,
          name: model.name,
          ...(model.customModelId != null ? { customModelId: model.customModelId } : {}),
          ...(was?.effort ? { effort: was.effort } : {}),
          ...(was?.deepThinking !== undefined ? { deepThinking: was.deepThinking } : {}),
        });
        void IpcClient.getInstance()
          .setWorkspaceSessionModel(sessionId, {
            provider: model.provider,
            name: model.name,
            ...(model.customModelId != null ? { customModelId: model.customModelId } : {}),
          })
          .then((row) => {
            if (store.get(activeWorkspaceSessionIdAtom) === sessionId) {
              store.set(activeSessionModelAtom, (row as { model?: SessionModelChoice | null }).model ?? null);
            }
          })
          .catch((e) => console.warn("[model] failed to persist the chat's model:", e));
      }
      await updateSettings({ selectedModel: model });
      // Your own pick ends one another session set for the chat in front of you (item 9).
      const here = [store.get(selectedChatIdAtom), store.get(activeChatIdAtom)];
      store.set(peerModelByChatIdAtom, (prev) => {
        if (!here.some((id) => id != null && prev.has(id))) return prev;
        const next = new Map(prev);
        for (const id of here) if (id != null) next.delete(id);
        return next;
      });
      queryClient.invalidateQueries({ queryKey: TOKEN_COUNT_QUERY_KEY });
      // The user's own pick is not news: move the "your Core model changed"
      // baseline to it, or the banner announced it, often in the wrong
      // direction (QA #46).
      void IpcClient.getInstance()
        .ackCoreSlotChange()
        .catch(() => {});
    },
    [updateSettings, queryClient],
  );
}
