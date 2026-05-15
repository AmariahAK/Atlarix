/**
 * Token Budget Settings
 * =====================
 * Optional per-provider token caps to control API costs.
 * When set, warnings appear earlier and usage is capped for display.
 *
 * Note on placeholders: a single provider hosts many models with different
 * context windows (e.g. OpenRouter spans 8K → 1M+, Compass-fast advertises
 * 1M while older Compass tiers cap lower). We therefore avoid hardcoded
 * per-provider numbers and let `getEffectiveBudget` / `getContextWindow`
 * resolve the real ceiling per active model.
 */

import { useSettings } from "@/hooks/useSettings";
import { useState } from "react";
import { AlertCircle } from "lucide-react";

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  compass: "Compass",
  openrouter: "OpenRouter",
  groq: "Groq",
  togetherai: "Together AI",
  mistral: "Mistral",
  xai: "xAI",
};

export function TokenBudgetSettings() {
  const { settings, updateSettings } = useSettings();
  const [localValues, setLocalValues] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);

  const overrides = settings?.tokenBudgetOverrides ?? {};
  const displayValue = (id: string) =>
    localValues[id] ?? (overrides[id] != null ? String(overrides[id]) : "");

  const handleBlur = async (providerId: string, value: string) => {
    const num = value.trim() ? parseInt(value, 10) : undefined;
    if (isSaving) return;
    const newVal =
      num != null && !isNaN(num) && num > 0 ? num : undefined;
    const currentVal = overrides[providerId];
    if (newVal === currentVal) return;
    setIsSaving(true);
    try {
      const next = { ...overrides };
      if (num != null && !isNaN(num) && num > 0) {
        next[providerId] = num;
      } else {
        delete next[providerId];
      }
      await updateSettings({ tokenBudgetOverrides: next });
      setLocalValues((prev) => {
        const next = { ...prev };
        delete next[providerId];
        return next;
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Optionally cap the token budget per provider. When set, the chat will
        show warnings earlier and display usage against your cap. Leave blank to
        use the model&apos;s full context window.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {Object.entries(PROVIDER_LABELS).map(([id, label]) => (
          <div key={id} className="flex items-center gap-2">
            <label className="text-sm w-28 shrink-0">{label}</label>
            <input
              type="number"
              min={1000}
              max={2000000}
              step={1000}
              placeholder="Auto · model context"
              value={displayValue(id)}
              onChange={(e) =>
                setLocalValues((prev) => ({ ...prev, [id]: e.target.value }))
              }
              onBlur={(e) => handleBlur(id, e.target.value)}
              className="flex-1 px-2 py-1.5 text-sm rounded border border-border bg-background"
            />
            <span className="text-xs text-muted-foreground">tokens</span>
          </div>
        ))}
      </div>
      {Object.keys(overrides).length > 0 && (
        <div className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>
            {Object.keys(overrides).length} provider(s) capped. Token bar will
            show &quot;(capped)&quot; and warn at 80%.
          </span>
        </div>
      )}
    </div>
  );
}
