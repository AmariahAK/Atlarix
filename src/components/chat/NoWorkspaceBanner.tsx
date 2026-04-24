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
        "flex items-center gap-2 rounded-md border-l-4 px-3 py-2 text-sm",
        "border-l-[#F59E0B] bg-[#FEF3C7] text-[#92400E]",
        "dark:border-l-amber-500 dark:bg-amber-500/10 dark:text-amber-100",
        className
      )}
      data-testid="no-workspace-banner"
    >
      <AlertTriangle className="h-4 w-4 shrink-0 text-[#F59E0B] dark:text-amber-500" />
      <p className="text-current">
        No workspace selected. Only Ask mode available.
        {onSelectWorkspace && (
          <>
            {" "}
            <button
              type="button"
              onClick={onSelectWorkspace}
              className="text-[#92400E] hover:underline dark:text-amber-300"
            >
              Select workspace to enable Build
            </button>
          </>
        )}
      </p>
    </div>
  );
}
