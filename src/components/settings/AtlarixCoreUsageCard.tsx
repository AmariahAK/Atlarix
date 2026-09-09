import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCreditBalance } from "@/hooks/useCreditBalance";
import { formatCompassSubscriptionTier } from "@/shared/compass_product_copy";
import { useAuth } from "@/lib/auth/useAuth";
import { CreditSplitBar } from "./CreditSplitBar";
import {
  CORE_PAYMENT_SUMMARY,
  NEGATIVE_BALANCE_EXPLAINER,
  formatCents,
} from "@/shared/billing_copy";

type AtlarixCoreUsageCardProps = {
  className?: string;
  showIntro?: boolean;
};

const PRESET_TOPUPS_CENTS = [1000, 2000, 5000] as const;
const MIN_TOPUP_CENTS = 1000;

function getInvoke():
  | ((channel: string, ...args: unknown[]) => Promise<unknown>)
  | null {
  const electron = (
    window as unknown as {
      electron?: {
        ipcRenderer?: {
          invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
        };
      };
    }
  ).electron;
  return electron?.ipcRenderer?.invoke ?? null;
}

export function AtlarixCoreUsageCard({
  className = "",
  showIntro = true,
}: AtlarixCoreUsageCardProps) {
  const {
    balanceCents,
    grantedCents,
    grantedTotalCents,
    purchasedCents,
    loading,
    error,
    needsSignIn,
  } = useCreditBalance();
  const { status } = useAuth();
  // Additive tally — tap $20 then $10 → a running $30 total; custom adds any amount.
  const [tallyCents, setTallyCents] = useState(0);
  const [customDollars, setCustomDollars] = useState("");
  const [topUpPending, setTopUpPending] = useState(false);
  const [topUpHint, setTopUpHint] = useState<string | null>(null);
  const [topUpError, setTopUpError] = useState<string | null>(null);

  const tier = status?.plan ?? null;
  // THE HEADLINE IS PURCHASED CREDIT, not the spendable total.
  //
  // The total merges two things a reader cannot act on together: money they
  // bought, which never expires, and an allowance that resets. Adding them
  // produced "$2,000,000.40" on an account whose actual credit is half that,
  // and the sum answers no question — the allowance is spent first anyway, so
  // this number is exactly what is left once it runs out.
  //
  // Falls back to the total when the server reports no split, because a
  // headline of "$0.00" on an account with a balance would be worse than a
  // slightly broad one.
  const headlineCents = purchasedCents ?? balanceCents;
  const balanceLabel =
    typeof headlineCents === "number" ? formatCents(headlineCents) : null;
  // A negative balance means a prior refund was clawed back after the credit had
  // already been spent — the reserve gate blocks Core until a top-up covers it.
  // Against the headline, which is now purchased credit — that is the column a
  // refund can drive below zero. An allowance is floored at zero by the schema.
  const balanceIsNegative =
    typeof headlineCents === "number" && headlineCents < 0;
  const tallyLabel = `$${(tallyCents / 100).toFixed(2)}`;

  const addToTally = (cents: number) => {
    setTopUpError(null);
    setTopUpHint(null);
    setTallyCents((t) => t + cents);
  };

  const addCustom = () => {
    const dollars = Number.parseFloat(customDollars);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      setTopUpError("Enter a dollar amount to add.");
      return;
    }
    // Enforce the floor at ENTRY, not just at confirm. A custom amount under the
    // minimum used to be accepted into the tally and only rejected later, which reads
    // as the amount having been added when it can never be purchased on its own.
    const cents = Math.round(dollars * 100);
    if (cents < MIN_TOPUP_CENTS) {
      setTopUpError(`Custom amounts start at $${MIN_TOPUP_CENTS / 100}.`);
      return;
    }
    addToTally(cents);
    setCustomDollars("");
  };

  const resetTally = () => {
    setTallyCents(0);
    setCustomDollars("");
    setTopUpError(null);
    setTopUpHint(null);
  };

  const confirmTopUp = async () => {
    setTopUpError(null);
    setTopUpHint(null);
    if (tallyCents < MIN_TOPUP_CENTS) {
      setTopUpError("Minimum top-up is $10.");
      return;
    }
    try {
      setTopUpPending(true);
      const invoke = getInvoke();
      if (!invoke) {
        setTopUpError("Top-up is unavailable in this environment.");
        return;
      }
      const result = (await invoke("auth:add-credit", tallyCents)) as
        | { success: boolean; error?: string }
        | undefined;
      if (result?.success) {
        setTopUpHint(
          "Checkout opened in your browser — your balance updates here after payment.",
        );
        setTallyCents(0);
      } else {
        setTopUpError(result?.error ?? "Could not start the top-up checkout.");
      }
    } catch (e) {
      setTopUpError(e instanceof Error ? e.message : "Could not start top-up.");
    } finally {
      setTopUpPending(false);
    }
  };

  const controlsDisabled = loading || needsSignIn || topUpPending;

  return (
    <div
      className={`space-y-3 rounded-lg border border-border p-4 ${className}`}
    >
      {showIntro ? (
        <p className="text-xs text-muted-foreground leading-relaxed">
          {CORE_PAYMENT_SUMMARY}
        </p>
      ) : null}

      <div className="flex items-center justify-between text-sm gap-2">
        <span className="text-muted-foreground shrink-0">Account tier</span>
        {tier ? (
          <span className="font-medium text-foreground">
            {formatCompassSubscriptionTier(tier)}
          </span>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        )}
      </div>

      <div className="flex items-center justify-between text-sm gap-2">
        <span className="text-muted-foreground shrink-0">Your credit</span>
        {loading ? (
          <span className="text-muted-foreground">…</span>
        ) : error ? (
          <span className="text-muted-foreground text-xs text-right max-w-[min(100%,280px)]">
            {error}
          </span>
        ) : needsSignIn ? (
          <span className="text-muted-foreground text-xs">
            Sign in to view balance
          </span>
        ) : balanceLabel ? (
          <span
            className={`font-semibold tabular-nums text-base ${
              balanceIsNegative ? "text-destructive" : "text-foreground"
            }`}
          >
            {balanceLabel}
          </span>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        )}
      </div>

      {/* The split sits directly under the total it explains. It draws nothing
          when the server reported no split, or when there is nothing to spend. */}
      {!loading && !error && !needsSignIn ? (
        <CreditSplitBar
          grantedCents={grantedCents}
          grantedTotalCents={grantedTotalCents}
        />
      ) : null}

      {balanceIsNegative ? (
        <p className="text-xs text-muted-foreground leading-relaxed">
          {NEGATIVE_BALANCE_EXPLAINER}
        </p>
      ) : null}

      <div className="space-y-2 pt-1">
        <div className="flex flex-wrap items-center gap-2">
          {PRESET_TOPUPS_CENTS.map((cents) => (
            <Button
              key={cents}
              type="button"
              size="sm"
              variant="outline"
              disabled={controlsDisabled}
              onClick={() => addToTally(cents)}
            >
              +${cents / 100}
            </Button>
          ))}
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground text-sm">$</span>
            <Input
              type="number"
              inputMode="decimal"
              min={MIN_TOPUP_CENTS / 100}
              step={1}
              placeholder="Custom"
              value={customDollars}
              onChange={(e) => setCustomDollars(e.target.value)}
              disabled={controlsDisabled}
              className="h-8 w-24 tabular-nums"
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={controlsDisabled || customDollars.trim() === ""}
              onClick={addCustom}
            >
              Add
            </Button>
          </div>
        </div>

        {tallyCents > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2">
            <span className="text-sm">
              You'll pay{" "}
              <span className="font-semibold tabular-nums">{tallyLabel}</span>
              {tallyCents < MIN_TOPUP_CENTS ? (
                <span className="text-xs text-muted-foreground">
                  {" "}
                  (min $10)
                </span>
              ) : null}
            </span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={resetTally}
                disabled={topUpPending}
              >
                Reset
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={controlsDisabled || tallyCents < MIN_TOPUP_CENTS}
                onClick={() => void confirmTopUp()}
              >
                {topUpPending ? "Opening…" : `Top up ${tallyLabel}`}
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Tap amounts to build a top-up (minimum $10), then confirm.
          </p>
        )}

        {topUpError ? (
          <p className="text-xs text-destructive">{topUpError}</p>
        ) : topUpHint ? (
          <p className="text-xs text-muted-foreground">{topUpHint}</p>
        ) : null}
      </div>
    </div>
  );
}
