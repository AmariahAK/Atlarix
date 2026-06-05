import { useAtlarixCoreCatalog } from "@/hooks/useAtlarixCoreCatalog";
import {
  ATLARIX_CORE_CATEGORY_LABEL,
  CORE_TIER_ROWS,
} from "@/shared/compass_product_copy";
import { displayLabelForCompassTier } from "@/lib/atlarix-core-catalog";
import { AtlarixCoreUsageCard } from "@/components/settings/AtlarixCoreUsageCard";

export function CompassProviderSettings() {
  const { data: catalog = [] } = useAtlarixCoreCatalog();

  return (
    <div className="mt-6 space-y-6">
      <p className="text-sm text-muted-foreground">
        <strong>{ATLARIX_CORE_CATEGORY_LABEL}</strong> models are included with your
        Atlarix subscription and billed against your monthly token quota (not BYOK).
        Every plan can use all Core models — usage is metered by tokens, not by tier.
      </p>

      <div className="space-y-4">
        {CORE_TIER_ROWS.map((m) => {
          return (
            <div
              key={m.id}
              className="rounded-lg border border-border bg-card/50 p-4"
            >
              <h3 className="font-medium text-foreground">
                {m.label} — {displayLabelForCompassTier(m.id, catalog)}
              </h3>
              <p className="text-sm text-muted-foreground mt-1">{m.description}</p>
            </div>
          );
        })}
      </div>

      <AtlarixCoreUsageCard />

      <p className="text-xs text-muted-foreground text-center pt-2">
        Powered by OpenRouter
      </p>
    </div>
  );
}
