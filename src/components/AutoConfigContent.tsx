/**
 * Config panel for Auto mode: pick one provider (with API key) and 3 models for routing.
 */

import { useSettings } from "@/hooks/useSettings";
import { useLanguageModelProviders } from "@/hooks/useLanguageModelProviders";
import { useLanguageModelsForProvider } from "@/hooks/useLanguageModelsForProvider";
import { useAtlarixCoreCatalog } from "@/hooks/useAtlarixCoreCatalog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { buildAutoSettingsForProvider } from "@/lib/routing/auto-settings-defaults-ui";
import type { AtlarixCoreTierSlot } from "@/lib/atlarix-core-catalog";
import { findCatalogEntryBySlot } from "@/lib/atlarix-core-catalog";

const AUTO_SLOTS: AtlarixCoreTierSlot[] = ["fast", "balanced", "thinking"];

function tierSlotLabel(
  index: 0 | 1 | 2,
  autoProviderId: string | null,
  catalog: ReturnType<typeof useAtlarixCoreCatalog>["data"],
): string {
  if (autoProviderId === "compass") {
    const entry = catalog
      ? findCatalogEntryBySlot(catalog, AUTO_SLOTS[index])
      : undefined;
    return entry?.labelWithProvider ?? `Model ${index + 1}`;
  }
  return `Model ${index + 1}`;
}

export function AutoConfigContent() {
  const { settings, updateSettings } = useSettings();
  const { data: providers = [], isProviderSetup } = useLanguageModelProviders();
  const { data: coreCatalog = [] } = useAtlarixCoreCatalog();
  const autoProviderId = settings?.autoProviderId ?? null;
  const autoModelIds: [string, string, string] = settings?.autoModelIds ?? [
    "",
    "",
    "",
  ];
  const { data: models = [] } = useLanguageModelsForProvider(
    autoProviderId ?? undefined,
  );

  const providersWithKey = providers.filter((p) => isProviderSetup(p.id));

  const setAutoProviderId = (id: string | null) => {
    if (!settings) return;
    const patch = buildAutoSettingsForProvider(id, settings);
    updateSettings({
      autoModelRouting: true,
      autoProviderId: patch.autoProviderId,
      autoModelIds: patch.autoModelIds,
    });
  };

  const setAutoModelAt = (index: 0 | 1 | 2, apiName: string) => {
    const next: [string, string, string] = [
      autoModelIds[0] ?? "",
      autoModelIds[1] ?? "",
      autoModelIds[2] ?? "",
    ];
    next[index] = apiName;
    updateSettings({ autoModelIds: next });
  };

  return (
    <div className="space-y-4 p-4 min-w-[280px]">
      <div>
        <h3 className="font-medium">Auto (provider + 3 models)</h3>
        <p className="text-sm text-muted-foreground">
          One provider and three models for complexity routing (Atlarix Core uses
          included OpenRouter models).
        </p>
      </div>

      <div className="space-y-2">
        <Label className="text-xs">Provider</Label>
        <Select
          value={autoProviderId ?? ""}
          onValueChange={(v) => setAutoProviderId(v || null)}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select provider" />
          </SelectTrigger>
          <SelectContent>
            {providersWithKey.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {autoProviderId && (
        <div className="space-y-3">
          {([0, 1, 2] as const).map((i) => {
            const label = tierSlotLabel(i, autoProviderId, coreCatalog);
            return (
              <div key={i} className="space-y-1">
                <Label className="text-xs">{label}</Label>
                <Select
                  value={autoModelIds[i] ?? ""}
                  onValueChange={(v) => setAutoModelAt(i, v)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={`Select ${label}`} />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((m) => (
                      <SelectItem key={m.apiName} value={m.apiName}>
                        {m.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          })}
        </div>
      )}

      {providersWithKey.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Set up at least one provider in Settings → Model Providers.
        </p>
      )}
    </div>
  );
}
