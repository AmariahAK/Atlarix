import { useAtlarixCoreCatalog } from "@/hooks/useAtlarixCoreCatalog";
import { ATLARIX_CORE_CATEGORY_LABEL } from "@/shared/compass_product_copy";
import { AtlarixCoreUsageCard } from "@/components/settings/AtlarixCoreUsageCard";

export function CompassProviderSettings() {
  const { data: catalog = [] } = useAtlarixCoreCatalog();

  // Read the live Core models from the resolved catalog (hosted core-models.json).
  // The catalog already omits slots with no mapped model, so the row COUNT follows
  // the lineup — 2, 3 or 4 — with nothing hardcoded here.
  //
  // No CORE_TIER_ROWS fallback: it always produced four "Core N" placeholder rows,
  // which is wrong twice over now — wrong count for a smaller lineup, and naming
  // slots that may not exist. A brief loading line is honest; four fake rows are not.
  const coreModels = catalog.map((entry) => ({
    id: entry.internalTierId,
    label: entry.labelWithProvider,
  }));

  return (
    <div className="mt-6 space-y-6">
      <p className="text-sm text-muted-foreground">
        <strong>{ATLARIX_CORE_CATEGORY_LABEL}</strong> models are pay-as-you-go —
        metered per use from your prepaid credit balance (no API key needed). Every
        plan can use all Core models; top up your balance any time below.
      </p>

      <div className="space-y-4">
        {coreModels.length === 0 ? (
          <p className="text-sm text-muted-foreground">Loading Core models…</p>
        ) : (
          coreModels.map((m) => (
            <div
              key={m.id}
              className="rounded-lg border border-border bg-card/50 p-4"
            >
              <h3 className="font-medium text-foreground">{m.label}</h3>
            </div>
          ))
        )}
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
