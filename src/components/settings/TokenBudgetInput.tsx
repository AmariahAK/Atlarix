/**
 * Token Budget Input - Per-provider token cap
 * Shown inside each provider's settings page.
 *
 * No hardcoded per-provider ceilings: a single provider hosts many models
 * with different context windows (e.g. OpenRouter spans 8K → 1M+), so any
 * fixed number here is wrong for most of them. We delegate to the model's
 * real context window via `getEffectiveBudget` / `getContextWindow` and
 * present this field purely as an *override* with a non-numeric hint.
 */

import { useSettings } from "@/hooks/useSettings";
import { useState } from "react";

interface TokenBudgetInputProps {
  providerId: string;
  label?: string;
}

export function TokenBudgetInput({
  providerId,
  label = "Token budget cap",
}: TokenBudgetInputProps) {
  const { settings, updateSettings } = useSettings();
  const [localValue, setLocalValue] = useState<string>("");
  const [isSaving, setIsSaving] = useState(false);

  const overrides = settings?.tokenBudgetOverrides ?? {};
  const displayValue =
    localValue !== ""
      ? localValue
      : overrides[providerId] != null
        ? String(overrides[providerId])
        : "";
  // Placeholder is intentionally non-numeric — see file header. The active
  // ceiling is whatever `getContextWindow(selectedModel, chatId)` resolves.
  const placeholder = "Auto · model context";

  const handleBlur = async () => {
    const num = displayValue.trim() ? parseInt(displayValue, 10) : undefined;
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
      setLocalValue("");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="mt-6 space-y-2">
      <h3 className="text-sm font-medium text-foreground">{label}</h3>
      <p className="text-xs text-muted-foreground">
        Optionally cap the token budget for this provider. When set, the chat
        shows warnings earlier. Leave blank to use the model&apos;s full context
        window.
      </p>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={1000}
          max={2000000}
          step={1000}
          placeholder={placeholder}
          value={displayValue}
          onChange={(e) => setLocalValue(e.target.value)}
          onBlur={handleBlur}
          disabled={isSaving}
          className="flex-1 max-w-[140px] px-2 py-1.5 text-sm rounded border border-border bg-background"
        />
        <span className="text-xs text-muted-foreground">tokens</span>
      </div>
    </div>
  );
}
