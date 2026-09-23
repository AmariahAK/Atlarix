import { Lock } from "lucide-react";
import type { AccountKind } from "@/hooks/useAccountKind";
import { CORE_BADGE } from "@/shared/billing_copy";

/**
 * Badge text is a DEEPER green in light mode and a LIGHTER one in dark, not the
 * brand `text-primary`: at 10px over a tinted row, primary measured 2.8:1 in light
 * and 3.3:1 on a selected dark row — under the 4.5:1 small text needs (reported as
 * "hard to read", 2026-09-23). These land around 6–7:1 in both themes.
 */
const badgeText = "text-emerald-800 dark:text-emerald-300";

const basePill =
  "text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 whitespace-nowrap";

/**
 * Model price badge:
 *  - Atlarix Core → what it means for THIS account: Atlarix Auto is "Free" for
 *    a free account, "Included" on Pro, "Credits" on pay-as-you-go; a pinned
 *    Core model is "Included" / "Credits", or locked ("Pro / Credits") for a
 *    free account.
 *  - Priced BYOK/catalog models → real output price per 1M tokens (models.dev).
 *  - Local models + genuinely $0 models → "Free".
 */
export function PriceBadge({
  cost,
  core,
  account = "unknown",
}: {
  cost?: { input: number; output: number };
  /** Set for Atlarix Core rows. */
  core?: "auto" | "pinned";
  account?: AccountKind;
}) {
  if (core) {
    const label =
      account === "pro"
        ? CORE_BADGE.included
        : account === "payg"
          ? CORE_BADGE.credits
          : core === "auto"
            ? CORE_BADGE.free
            : account === "free"
              ? CORE_BADGE.locked
              : CORE_BADGE.credits;
    const locked = core === "pinned" && account === "free";
    return (
      <span
        data-testid="core-badge"
        className={`${basePill} inline-flex items-center gap-1 ${
          label === CORE_BADGE.free
            ? `${badgeText} border border-primary`
            : `bg-primary/10 ${badgeText}`
        }`}
      >
        {locked && <Lock className="h-2.5 w-2.5" aria-hidden />}
        {label}
      </span>
    );
  }

  const out = cost?.output ?? 0;
  const inp = cost?.input ?? 0;
  const priced = out > 0 || inp > 0;

  if (!priced) {
    return (
      <span className={`${basePill} ${badgeText} border border-primary`}>
        Free
      </span>
    );
  }

  const label = out >= 1 ? `$${out.toFixed(2)}/M` : `$${out.toFixed(3)}/M`;
  return (
    <span
      className={`${basePill} bg-primary/10 ${badgeText}`}
      title={`Per 1M tokens — input $${inp}, output $${out}`}
    >
      {label}
    </span>
  );
}
