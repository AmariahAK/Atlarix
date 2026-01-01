import React from "react";

/**
 * MaxChatTurnsSelector - Static Info Display
 * ==========================================
 * Shows the fixed chat turns value (5) as informational text.
 * Currently not configurable by users.
 */
export const MaxChatTurnsSelector: React.FC = () => {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-4">
        <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
          Chat context turns
        </label>
        <span className="px-3 py-1.5 bg-muted rounded-md text-sm font-medium text-foreground">
          5 turns
        </span>
      </div>
      <div className="text-sm text-gray-500 dark:text-gray-400">
        Atlarix uses the last 5 chat exchanges for context. This provides a good balance between conversation continuity and response speed.
      </div>
    </div>
  );
};
