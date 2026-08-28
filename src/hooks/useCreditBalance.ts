import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { toast } from "sonner";
import { compassUsageBumpAtom } from "@/atoms/viewAtoms";
import { allowanceUsedUpNudge, lowBalanceNudge } from "@/shared/billing_copy";

/** Warn once when the Core credit balance drops below this (but isn't yet empty). */
const LOW_CREDIT_CENTS = 100; // $1

export interface CreditBalanceState {
  /**
   * SPENDABLE Atlarix Core balance in integer cents, or null when unknown.
   * Allowance plus purchased credit — this is the number every gate reads, and
   * the two fields below say what it is made of.
   */
  balanceCents: number | null;
  /**
   * The part that RESETS each billing period, or null when the server did not
   * report a split. Null is not zero: an older server that returns only a total
   * must not be rendered as "your allowance is empty".
   */
  grantedCents: number | null;
  /**
   * What the period GRANTED, so consumption is `grantedTotalCents -
   * grantedCents`. Without it the card can only show what the two halves are
   * worth side by side, which answers "what is my balance made of" when the
   * question being asked is "how much of my included usage have I spent".
   */
  grantedTotalCents: number | null;
  /** The part the user PAID for, which never expires. Null as above. */
  purchasedCents: number | null;
  loading: boolean;
  /** RPC/network failure — distinct from signed out. */
  error: string | null;
  /** True when the balance RPC reports no authenticated user. */
  needsSignIn: boolean;
  refetch: () => Promise<void>;
}

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

/**
 * Atlarix Core prepaid credit balance (PAYG wallet) from Supabase via main-process IPC.
 * Refetches on mount and whenever `compassUsageBumpAtom` increments (after Core
 * chat turns spend credit), mirroring the old `useCompassUsage` refresh trigger.
 */
export function useCreditBalance(): CreditBalanceState {
  const bump = useAtomValue(compassUsageBumpAtom);
  const [balanceCents, setBalanceCents] = useState<number | null>(null);
  const [grantedCents, setGrantedCents] = useState<number | null>(null);
  const [grantedTotalCents, setGrantedTotalCents] = useState<number | null>(null);
  const [purchasedCents, setPurchasedCents] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);

  const refetch = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setNeedsSignIn(false);
      const invoke = getInvoke();
      if (!invoke) {
        setBalanceCents(null);
        setGrantedCents(null);
        setGrantedTotalCents(null);
        setPurchasedCents(null);
        setError("Credit balance is unavailable in this environment.");
        return;
      }
      const result = (await invoke("auth:get-credit-balance")) as
        | {
            ok: boolean;
            balanceCents: number;
            grantedCents?: number | null;
            grantedTotalCents?: number | null;
            purchasedCents?: number | null;
            error?: string;
          }
        | undefined;
      if (!result?.ok) {
        setBalanceCents(null);
        setGrantedCents(null);
        setGrantedTotalCents(null);
        setPurchasedCents(null);
        if (result?.error) {
          setError(result.error);
        } else {
          // RPC returned ok:false with no error → no authenticated user.
          setNeedsSignIn(true);
        }
        return;
      }
      setBalanceCents(Number(result.balanceCents ?? 0));
      setGrantedCents(typeof result.grantedCents === "number" ? result.grantedCents : null);
      setGrantedTotalCents(
        typeof result.grantedTotalCents === "number" ? result.grantedTotalCents : null,
      );
      setPurchasedCents(typeof result.purchasedCents === "number" ? result.purchasedCents : null);
    } catch (e) {
      setBalanceCents(null);
      setGrantedCents(null);
      setGrantedTotalCents(null);
      setPurchasedCents(null);
      setError(e instanceof Error ? e.message : "Could not load credit balance");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch, bump]);

  return {
    balanceCents,
    grantedCents,
    grantedTotalCents,
    purchasedCents,
    loading,
    error,
    needsSignIn,
    refetch,
  };
}

/**
 * Two nudges, at the two moments a balance changes character.
 *
 * 1. THE ALLOWANCE EMPTIES. The month's included usage is gone and the user is
 *    now spending money they paid. Nothing is broken and nothing has stopped, so
 *    this is not a warning — but it is the only reason the app tracks the halves
 *    separately, and a user who never sees it will read their next top-up as the
 *    subscription having failed to include anything.
 * 2. THE WHOLE BALANCE RUNS LOW (under $1, not yet empty). Empty is handled by
 *    the hard stop on the next Core call.
 *
 * Each fires ONCE and re-arms only when the condition genuinely reverses, so a
 * balance hovering at the threshold cannot toast on every turn.
 *
 * Call this ONCE from an always-mounted component, not per consumer.
 */
export function useLowBalanceNudge(): void {
  const { balanceCents, grantedCents, purchasedCents } = useCreditBalance();
  const nudgedRef = useRef(false);
  const allowanceNudgedRef = useRef(false);

  useEffect(() => {
    // Only meaningful when the server reported a split AND there is purchased
    // credit to fall back on. With nothing left at all, the low-balance nudge
    // below is the right message and this one would be noise on top of it.
    if (grantedCents == null || purchasedCents == null) return;
    if (grantedCents > 0) {
      allowanceNudgedRef.current = false; // renewed → re-arm
      return;
    }
    if (purchasedCents > 0 && !allowanceNudgedRef.current) {
      allowanceNudgedRef.current = true;
      const { title, description } = allowanceUsedUpNudge(purchasedCents);
      toast.message(title, { description, duration: 8000 });
    }
  }, [grantedCents, purchasedCents]);

  useEffect(() => {
    if (balanceCents == null) return;
    if (balanceCents >= LOW_CREDIT_CENTS) {
      nudgedRef.current = false; // topped back up → re-arm
      return;
    }
    if (balanceCents > 0 && !nudgedRef.current) {
      nudgedRef.current = true;
      const { title, description } = lowBalanceNudge(balanceCents);
      toast.message(title, { description, duration: 8000 });
    }
  }, [balanceCents]);
}
