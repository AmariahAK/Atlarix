/**
 * Token Budget Input - Per-provider token cap
 * Shown inside each provider's settings page.
 *
 * No hardcoded per-provider ceilings: a single provider hosts many models
 * with different context windows (e.g. OpenRouter spans 8K → 1M+), so any
 * fixed number here is wrong for most of them. We delegate to the model's
 * real context window via `getEffectiveBudget` / `getContextWindow` and
 * present this field purely as an *override* with a non-numeric hint.
 *
 * THE FIELD COULD NOT BE CLEARED (fixed 2026-09-02). `localValue` used `""` for
 * two different things — "the user has not typed anything, show the saved
 * value" and "the user emptied the field" — so `setLocalValue("")` on a delete
 * fell straight through to the saved override and the number snapped back. The
 * only way out was to type a second digit and then delete the first, which left
 * a literal `0` on screen; `0` then failed the `> 0` check on blur and silently
 * cleared the override, so the field showed a cap of zero while the provider was
 * actually on auto. Two states, one spelling, and the display disagreed with the
 * saved value.
 *
 * Now `null` means "not editing" and `""` means "cleared", which are different
 * values because they are different states. And because the reported symptom was
 * really "I cannot tell when it is back to auto", the component now SAYS which
 * state it is in and offers a one-click way back.
 */

import { useSettings } from "@/hooks/useSettings";
import { useState } from "react";
import { Button } from "@/components/ui/button";

interface TokenBudgetInputProps {
  providerId: string;
  label?: string;
}

/**
 * Below this a cap is not a cap, it is a broken session — the smallest real
 * context window in the catalog is several thousand tokens and the system
 * prefix alone is ~11-15K. Matches the `min` on the input so the spinner and
 * the save path cannot disagree.
 */
const MIN_BUDGET = 1000;
const MAX_BUDGET = 2_000_000;

export function TokenBudgetInput({
  providerId,
  label = "Token budget cap",
}: TokenBudgetInputProps) {
  const { settings, updateSettings } = useSettings();
  /** `null` = not editing. `""` = the user cleared it. Never conflate these. */
  const [localValue, setLocalValue] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const overrides = settings?.tokenBudgetOverrides ?? {};
  const savedValue = overrides[providerId];
  const displayValue =
    localValue !== null
      ? localValue
      : savedValue != null
        ? String(savedValue)
        : "";
  // Placeholder is intentionally non-numeric — see file header. The active
  // ceiling is whatever `getContextWindow(selectedModel, chatId)` resolves.
  const placeholder = "Auto · model context";

  const commit = async (raw: string) => {
    if (isSaving) return;
    const trimmed = raw.trim();
    const parsed = trimmed ? Number.parseInt(trimmed, 10) : Number.NaN;

    let next: number | undefined;
    let message: string | null = null;

    if (!trimmed || Number.isNaN(parsed) || parsed <= 0) {
      // Empty, zero, or nonsense all mean the same thing: no cap.
      next = undefined;
    } else if (parsed < MIN_BUDGET) {
      // Clamp rather than discard — someone typing 500 wants a small cap, not
      // auto, and silently dropping their intent is the worse surprise. Say so.
      next = MIN_BUDGET;
      message = `Raised to the ${MIN_BUDGET.toLocaleString()} minimum.`;
    } else if (parsed > MAX_BUDGET) {
      next = MAX_BUDGET;
      message = `Capped at the ${MAX_BUDGET.toLocaleString()} maximum.`;
    } else {
      next = parsed;
    }

    setNotice(message);

    if (next === savedValue) {
      // Nothing to write, but the local edit must still be released or the
      // field would keep showing a stale draft.
      setLocalValue(null);
      return;
    }

    setIsSaving(true);
    try {
      const updated = { ...overrides };
      if (next == null) {
        delete updated[providerId];
      } else {
        updated[providerId] = next;
      }
      await updateSettings({ tokenBudgetOverrides: updated });
      setLocalValue(null);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="mt-6 space-y-2">
      <h3 className="text-sm font-medium text-foreground">{label}</h3>
      <p className="text-xs text-muted-foreground">
        Optionally cap the token budget for this provider. When set, the chat
        shows warnings earlier. Clear the field to use the model&apos;s full
        context window.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="number"
          min={MIN_BUDGET}
          max={MAX_BUDGET}
          step={1000}
          placeholder={placeholder}
          value={displayValue}
          onChange={(e) => {
            setNotice(null);
            setLocalValue(e.target.value);
          }}
          onBlur={() => void commit(displayValue)}
          onKeyDown={(e) => {
            // Enter commits without needing to click away; Escape abandons the
            // draft and shows the saved value again.
            if (e.key === "Enter") {
              e.preventDefault();
              void commit(displayValue);
            } else if (e.key === "Escape") {
              e.preventDefault();
              setNotice(null);
              setLocalValue(null);
            }
          }}
          disabled={isSaving}
          className="flex-1 max-w-[140px] px-2 py-1.5 text-sm rounded border border-border bg-background"
        />
        <span className="text-xs text-muted-foreground">tokens</span>
        {savedValue != null ? (
          // The fix for what was actually being asked: "back to auto" is a
          // click, not a guess about whether an empty box took effect.
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isSaving}
            onClick={() => {
              setNotice(null);
              setLocalValue(null);
              void commit("");
            }}
            className="h-7 px-2 text-xs"
          >
            Use auto
          </Button>
        ) : null}
      </div>
      {/* State, in words. The old field could show "0" while the provider was
          on auto, so the number on screen was not the setting in force. */}
      <p className="text-xs text-muted-foreground">
        {notice ? <span className="text-foreground">{notice} </span> : null}
        {savedValue != null
          ? `Capped at ${savedValue.toLocaleString()} tokens.`
          : "No cap — using the model's full context window."}
      </p>
    </div>
  );
}
