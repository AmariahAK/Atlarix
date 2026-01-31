import React from "react";
import { useSettings } from "@/hooks/useSettings";
import { MAX_CHAT_TURNS_IN_CONTEXT } from "@/constants/settings_constants";

const TURN_OPTIONS = [5, 8, 10, 15, 20, 30] as const;

/**
 * MaxChatTurnsSelector - Configurable Chat Context
 * ================================================
 * User-configurable number of chat exchanges (user+assistant pairs) sent to the AI.
 * Higher = more context, slower; lower = faster, may lose context on long chats.
 */
export const MaxChatTurnsSelector: React.FC = () => {
  const { settings, updateSettings } = useSettings();
  const value =
    settings?.maxChatTurnsInContext ?? MAX_CHAT_TURNS_IN_CONTEXT;

  const handleChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const num = parseInt(e.target.value, 10);
    if (!isNaN(num)) {
      await updateSettings({ maxChatTurnsInContext: num });
    }
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-4">
        <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
          Chat context turns
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
      <div className="text-sm text-gray-500 dark:text-gray-400">
        Number of recent exchanges (user + assistant pairs) sent to the AI. Higher values
        improve context on long conversations but use more tokens.
      </div>
    </div>
  );
};
