/**
 * The one upgrade line and its two buttons — the same words everywhere a free
 * user hits a wall (picker lock, Auto's free limit, the low-balance hint).
 * The text lives in `billing_copy.ts`; this only renders it.
 */
import { CircleArrowUp, CreditCard } from "lucide-react";
import { triggerUpgrade } from "@/hooks/useUpgrade";
import { openSettingsSection } from "@/lib/open-settings-section";
import {
  ADD_CREDIT_LABEL,
  UPGRADE_LINE,
  UPGRADE_PRO_LABEL,
} from "@/shared/billing_copy";
import { cn } from "@/lib/utils";

/** Settings → AI holds the Core usage card and its top-up. */
export function openAddCredit(): void {
  openSettingsSection("ai");
}

export function UpgradeButtons({
  showUpgrade = true,
  className,
}: {
  /** Hidden for Pro accounts, who already have it. */
  showUpgrade?: boolean;
  className?: string;
}) {
  const base =
    "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium shadow-sm focus:outline-none focus:ring-2";
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {showUpgrade && (
        <button
          type="button"
          data-testid="upgrade-to-pro"
          className={cn(
            base,
            "bg-primary text-primary-foreground hover:bg-primary/90 focus:ring-primary/50",
          )}
          onClick={() => void triggerUpgrade()}
        >
          <span>{UPGRADE_PRO_LABEL}</span>
          <CircleArrowUp size={14} />
        </button>
      )}
      <button
        type="button"
        data-testid="add-credit"
        className={cn(
          base,
          "bg-secondary text-secondary-foreground hover:bg-secondary/80 focus:ring-ring",
        )}
        onClick={openAddCredit}
      >
        <span>{ADD_CREDIT_LABEL}</span>
        <CreditCard size={14} />
      </button>
    </div>
  );
}

/** The line plus the buttons, for surfaces that do not already show the line. */
export function UpgradeActions({ className }: { className?: string }) {
  return (
    <div className={cn("space-y-2 text-sm", className)}>
      <p className="text-muted-foreground">{UPGRADE_LINE}</p>
      <UpgradeButtons />
    </div>
  );
}
