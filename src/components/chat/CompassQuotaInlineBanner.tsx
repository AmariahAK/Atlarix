/**
 * Fix: Finding 5 — dismissible inline banner when Compass quota crosses consumed thresholds (see useCompassUsage).
 */

import { useAtom } from "jotai";
import { X } from "lucide-react";
import { compassMilestoneBannerAtom } from "@/atoms/viewAtoms";
import { Button } from "@/components/ui/button";

export function CompassQuotaInlineBanner() {
  const [message, setMessage] = useAtom(compassMilestoneBannerAtom);
  if (!message) return null;
  return (
    <div
      role="status"
      className="flex items-start gap-2 px-3 py-2 mx-2 mt-1 mb-1 rounded-md border border-amber-500/35 bg-amber-500/10 text-sm text-amber-950 dark:text-amber-100"
    >
      <span className="flex-1 min-w-0 leading-snug">{message}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0 text-amber-900/80 dark:text-amber-100/90"
        aria-label="Dismiss"
        onClick={() => setMessage(null)}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
