/**
 * Config panel for Auto mode: pick one provider (with API key) and 3 models (Fast / Medium / Thinking).
 */

import { useSettings } from "@/hooks/useSettings";
import { useLanguageModelProviders } from "@/hooks/useLanguageModelProviders";
import { useLanguageModelsForProvider } from "@/hooks/useLanguageModelsForProvider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";

const TIER_LABELS = ["Fast", "Medium", "Thinking"] as const;

export function AutoConfigContent() {
  const { settings, updateSettings } = useSettings();
  const { data: providers = [], isProviderSetup } = useLanguageModelProviders();
  const autoProviderId = settings?.autoProviderId ?? null;
  const autoModelIds: [string, string, string] = settings?.autoModelIds ?? [
    "",
    "",
    "",
  ];
  const { data: models = [] } = useLanguageModelsForProvider(
    autoProviderId ?? undefined
  );

  const providersWithKey = providers.filter((p) => isProviderSetup(p.id));

  const setAutoProviderId = (id: string | null) => {
    updateSettings({
      autoProviderId: id ?? null,
      autoModelIds: undefined,
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
          One provider and Fast / Medium / Thinking models for routing.
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
          {([0, 1, 2] as const).map((i) => (
            <div key={i} className="space-y-1">
              <Label className="text-xs">{TIER_LABELS[i]}</Label>
              <Select
                value={autoModelIds[i] ?? ""}
                onValueChange={(v) => setAutoModelAt(i, v)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={`Select ${TIER_LABELS[i]}`} />
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
          ))}
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
