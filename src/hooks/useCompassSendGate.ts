import { useMemo } from "react";
import { useSettings } from "@/hooks/useSettings";
import { useCompassUsage } from "@/hooks/useCompassUsage";
import type { LargeLanguageModel } from "@/lib/schemas";

/** True when Atlarix Core (compass) is the selected provider. */
export function selectionUsesCompass(
  selected: LargeLanguageModel | undefined,
): boolean {
  return selected?.provider === "compass";
}

/** When Compass is selected and monthly usage is exhausted, block sending on Compass. */
export function useCompassSendGate() {
  const { settings } = useSettings();
  const {
    percentRemaining,
    monthlyLimit,
    loading,
    tier,
    tokensUsedThisMonth,
  } = useCompassUsage();

  const usesCompass = useMemo(
    () =>
      settings?.selectedModel
        ? selectionUsesCompass(settings.selectedModel)
        : false,
    [settings?.selectedModel],
  );

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
