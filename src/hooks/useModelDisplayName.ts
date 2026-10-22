/**
 * The selected model's human name, resolved across every catalog we hold.
 *
 * MOVED OUT OF `ChatConfigDropdown` 2026-09-21. It lived there because that
 * menu was where the model's name was shown — as inert text above a "Change
 * model" item. The name is now the composer's model chip, and the config menu
 * no longer mentions models at all, so a hook exported from it would have been
 * a hook the file itself never used.
 *
 * Callers must truncate. `resolveModelDisplayLabel` falls back to
 * `"<model> (<provider>)"` for anything it cannot place, which is comfortably
 * wider than a composer chip; it also returns `"—"` with nothing selected and
 * `"Select a model"` under Auto routing.
 */

import { useSettings } from "@/hooks/useSettings";
import { useLanguageModelsByProviders } from "@/hooks/useLanguageModelsByProviders";
import { useLocalModels } from "@/hooks/useLocalModels";
import { useLocalLMSModels } from "@/hooks/useLMStudioModels";
import { useAtlarixCoreCatalog } from "@/hooks/useAtlarixCoreCatalog";
import { useLanguageModelProviders } from "@/hooks/useLanguageModelProviders";
import { resolveModelDisplayLabel } from "@/lib/resolve-model-display-label";
import type { LargeLanguageModel } from "@/lib/schemas";

export function useModelDisplayName(model?: LargeLanguageModel): string {
  const { settings } = useSettings();
  // The model this chat runs on, when it is not the app's selected one (a model
  // another session set for it, item 9: QA A15). Else the selected model.
  const shown = model ?? settings?.selectedModel;
  const { data: catalog = [] } = useAtlarixCoreCatalog();
  const { data: modelsByProviders } = useLanguageModelsByProviders();
  const { models: ollamaModels = [] } = useLocalModels();
  const { models: lmStudioModels = [] } = useLocalLMSModels();
  const { data: providers } = useLanguageModelProviders();

  return resolveModelDisplayLabel(shown, {
    providerName: providers?.find((p) => p.id === shown?.provider)?.name,
    catalog,
    modelsByProviders: modelsByProviders ?? undefined,
    ollamaDisplayName: ollamaModels.find(
      (m) => m.modelName === shown?.name,
    )?.displayName,
    lmStudioDisplayName: lmStudioModels.find(
      (m) => m.modelName === shown?.name,
    )?.displayName,
  });
}
