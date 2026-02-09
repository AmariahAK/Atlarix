/**
 * Shown when no workspace is selected. Only Ask mode is available; no building.
 * Uses Lucide AlertTriangle (no emoji).
 */

import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

export function NoWorkspaceBanner({
  onSelectWorkspace,
  className,
}: {
  onSelectWorkspace?: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border-l-4 border-amber-500 bg-amber-500/10 px-3 py-2 text-sm",
        className
      )}
      data-testid="no-workspace-banner"
    >
      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
      <p className="text-amber-200 dark:text-amber-100">
        No workspace selected. Only Ask mode available.
        {onSelectWorkspace && (
          <>
            {" "}
            <button
              type="button"
              onClick={onSelectWorkspace}
              className="text-amber-400 hover:underline dark:text-amber-300"
            >
              Select workspace to enable Build
            </button>
          </>
        )}
      </p>
    </div>
  );
}
