/**
 * First-launch onboarding: invite user to pick a workspace folder (not a warning).
 */

import { FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export function NoWorkspaceBanner({
  onOpenWorkspace,
  className,
}: {
  onOpenWorkspace?: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2.5 text-sm",
        "dark:border-primary/25 dark:bg-primary/10",
        "sm:flex-row sm:items-center sm:justify-between sm:gap-3",
        className
      )}
      data-testid="no-workspace-banner"
    >
      <div className="flex items-start gap-2 text-foreground min-w-0">
        <FolderOpen className="h-4 w-4 shrink-0 text-primary mt-0.5" aria-hidden />
        <span className="leading-snug">Pick a folder to unlock all modes</span>
      </div>
      {onOpenWorkspace ? (
        <Button
          type="button"
          variant="default"
          size="sm"
          className="shrink-0 w-full sm:w-auto"
          onClick={onOpenWorkspace}
        >
          Open workspace
        </Button>
      ) : null}
    </div>
  );
}
