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

import { IpcClient } from "@/ipc/ipc_client";
import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useSettings } from "@/hooks/useSettings";
import { TOKEN_COUNT_QUERY_KEY } from "@/hooks/useCountTokens";
import type { LargeLanguageModel } from "@/lib/schemas";

export function useSelectModel(): (model: LargeLanguageModel) => Promise<void> {
  const { updateSettings } = useSettings();
  const queryClient = useQueryClient();

  return useCallback(
    async (model: LargeLanguageModel) => {
      await updateSettings({ selectedModel: model });
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
