import { useMemo } from "react";
import { useLanguageModelsByProviders } from "@/hooks/useLanguageModelsByProviders";
import {
  coreTierPresentationFromModel,
  type AtlarixCoreTierPresentation,
} from "@/lib/atlarix-core-catalog";

/** Atlarix Core internal provider id. */
const COMPASS_PROVIDER_ID = "compass";

/**
 * Live Atlarix Core tier catalog (model name + provider per Core slot).
 *
 * Derived from `useLanguageModelsByProviders` — the same working source the
 * "Change model" picker reads — so Core rows show the real hosted model names
 * (Kimi, Qwen, DeepSeek, MiniMax) and update live when `core-models.json`
 * changes. That query is already invalidated on the `core-models:changed`
 * broadcast, so no separate wiring is needed. (The `compass:get-tier-catalog`
 * IPC is avoided here — see `coreTierPresentationFromModel` for why.)
 */
export function useAtlarixCoreCatalog() {
  const { data: byProvider, isLoading, error } = useLanguageModelsByProviders();

  const data = useMemo<AtlarixCoreTierPresentation[]>(() => {
    const models = byProvider?.[COMPASS_PROVIDER_ID] ?? [];
    return models.map(coreTierPresentationFromModel);
  }, [byProvider]);

  return { data, isLoading, error };
}
