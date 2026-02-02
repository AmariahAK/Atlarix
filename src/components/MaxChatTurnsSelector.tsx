import React from "react";
import { useSettings } from "@/hooks/useSettings";
import { MAX_CHAT_TURNS_IN_CONTEXT } from "@/constants/settings_constants";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

const TURN_OPTIONS = [5, 8, 10, 15, 20, 30] as const;

/**
 * MaxChatTurnsSelector - Context management
 * - When Context Bar + Auto-Summarize is ON: AI summarizes when context fills (Phase 6)
 * - When OFF: Uses fixed turn truncation as fallback
 */
export const MaxChatTurnsSelector: React.FC = () => {
  const { settings, updateSettings } = useSettings();
  const value =
    settings?.maxChatTurnsInContext ?? MAX_CHAT_TURNS_IN_CONTEXT;
  const autoSummarize = settings?.enableContextAutoSummarize !== false;

  const handleChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const num = parseInt(e.target.value, 10);
    if (!isNaN(num)) {
      await updateSettings({ maxChatTurnsInContext: num });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <Label className="text-sm font-medium">Context bar + auto-summarize</Label>
          <p className="text-xs text-muted-foreground mt-0.5">
            When context fills, the AI summarizes the session and continues. Preserves full
            session memory via summaries (Claude Code / OpenCode style).
          </p>
        </div>
        <Switch
          checked={autoSummarize}
          onCheckedChange={(checked) =>
            updateSettings({ enableContextAutoSummarize: checked })
          }
        />
      </div>

      {!autoSummarize && (
        <div className="space-y-1 pl-1 border-l-2 border-muted">
          <div className="flex items-center gap-4">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Chat context turns (fallback)
            </label>
            <select
              value={value}
              onChange={handleChange}
              className="px-3 py-1.5 rounded-md border border-border bg-background text-sm font-medium"
            >
              {TURN_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n} turns
                </option>
              ))}
            </select>
          </div>
          <p className="text-xs text-muted-foreground">
            Number of recent exchanges sent to the AI when auto-summarize is off.
          </p>
        </div>
      )}
    </div>
  );
};
