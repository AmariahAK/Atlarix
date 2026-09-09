import type { LargeLanguageModel } from "@/lib/schemas";

/** True when Atlarix Core (compass) is the selected provider. */
export function selectionUsesCompass(
  selected: LargeLanguageModel | undefined,
): boolean {
  return selected?.provider === "compass";
}
