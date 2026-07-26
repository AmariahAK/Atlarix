import { useAtlarixCoreCatalog } from "@/hooks/useAtlarixCoreCatalog";
import {
  ATLARIX_CORE_CATEGORY_LABEL,
  CORE_TIER_ROWS,
} from "@/shared/compass_product_copy";
import { displayLabelForCompassTier } from "@/lib/atlarix-core-catalog";
import { AtlarixCoreUsageCard } from "@/components/settings/AtlarixCoreUsageCard";

export function CompassProviderSettings() {
  const { data: catalog = [] } = useAtlarixCoreCatalog();

  // Read the live Core models from the resolved catalog (hosted core-models.json).
  // Fall back to the tier ids only until the catalog lands, so we never hardcode
  // the model names or show the raw "Core N" placeholders once ids resolve.
  const coreModels =
    catalog.length > 0
      ? catalog.map((entry) => ({
          id: entry.internalTierId,
          label: entry.labelWithProvider,
        }))
      : CORE_TIER_ROWS.map((row) => ({
          id: row.id,
          label: displayLabelForCompassTier(row.id, catalog),
        }));

  return (
    <div className="mt-6 space-y-6">
      <p className="text-sm text-muted-foreground">
        <strong>{ATLARIX_CORE_CATEGORY_LABEL}</strong> models are pay-as-you-go —
        metered per use from your prepaid credit balance (no API key needed). Every
        plan can use all Core models; top up your balance any time below.
      </p>

      <div className="space-y-4">
        {coreModels.map((m) => {
          return (
            <div
              key={m.id}
              className="rounded-lg border border-border bg-card/50 p-4"
            >
              <h3 className="font-medium text-foreground">{m.label}</h3>
            </div>
          );
        })}
      </div>

      <AtlarixCoreUsageCard />

      {/* The provider is now per-model and shown in each row's label (resolved from
          the hosted catalog), so a single hardcoded gateway name would be wrong the
          moment a tier is re-pointed — and it named a gateway Core no longer uses. */}
      <p className="text-xs text-muted-foreground text-center pt-2">
        Billed per use from your prepaid balance. No API key needed.
      </p>
    </div>
  );
}
