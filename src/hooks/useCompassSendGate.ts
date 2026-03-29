import { useMemo } from "react";
import { useSettings } from "@/hooks/useSettings";
import { useCompassUsage } from "@/hooks/useCompassUsage";
import type { LargeLanguageModel } from "@/lib/schemas";

function selectionUsesCompass(
  selected: LargeLanguageModel | undefined,
  autoProviderId: string | undefined,
): boolean {
  if (!selected) return false;
  if (selected.provider === "compass") return true;
  if (selected.provider === "auto" && autoProviderId === "compass") return true;
  return false;
}

/**
 * When Compass is selected and monthly usage is exhausted, block sending on Compass.
 * Optional one-shot model override (e.g. Auto routing) can use a non-Compass model.
 */
export function useCompassSendGate(modelOverride?: LargeLanguageModel | null) {
  const { settings } = useSettings();
  const {
    percentRemaining,
    monthlyLimit,
    loading,
    tier,
    tokensUsedThisMonth,
  } = useCompassUsage();

  const usesCompass = useMemo(() => {
    if (!settings?.selectedModel) return false;
    if (
      modelOverride &&
      modelOverride.provider &&
      modelOverride.provider !== "compass"
    ) {
      return false;
    }
    return selectionUsesCompass(
      settings.selectedModel,
      settings.autoProviderId ?? undefined,
    );
  }, [settings?.selectedModel, settings?.autoProviderId, modelOverride]);

  const compassExhausted =
    usesCompass &&
    !loading &&
    monthlyLimit != null &&
    monthlyLimit > 0 &&
    percentRemaining != null &&
    percentRemaining <= 0;

  return {
    compassExhausted,
    usesCompass,
    tier: tier ?? "free",
    percentRemaining,
    monthlyLimit,
    tokensUsedThisMonth,
    loading,
  };
}
