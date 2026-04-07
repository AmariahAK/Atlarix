import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { IpcClient } from "@/ipc/ipc_client";
import { compassMilestoneBannerAtom, compassUsageBumpAtom } from "@/atoms/viewAtoms";
import { toast } from "sonner";

export interface CompassUsageState {
  percentRemaining: number | null;
  tokensUsedThisMonth: number | null;
  monthlyLimit: number | null;
  tier: string | null;
  loading: boolean;
  /** Supabase/RPC or network failure — not the same as signed out */
  error: string | null;
  /** True when `get_compass_usage_state` reports no auth.uid() (signed out) */
  needsSignIn: boolean;
  refetch: () => Promise<void>;
}

/**
 * Compass monthly token usage from Supabase (via main-process IPC).
 * Refetches when `compassUsageBumpAtom` increments (after Compass chat turns).
 */
export function useCompassUsage(): CompassUsageState {
  const bump = useAtomValue(compassUsageBumpAtom);
  const setMilestoneBanner = useSetAtom(compassMilestoneBannerAtom);
  const [percentRemaining, setPercentRemaining] = useState<number | null>(null);
  const [tokensUsedThisMonth, setTokensUsedThisMonth] = useState<number | null>(null);
  const [monthlyLimit, setMonthlyLimit] = useState<number | null>(null);
  const [tier, setTier] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);

  const prevPercentRef = useRef<number | null>(null);
  const milestoneToastedRef = useRef<Set<string>>(new Set());
  const prevConsumedRef = useRef<number | null>(null);
  const milestoneInlineRef = useRef<Set<string>>(new Set());

  const refetch = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setNeedsSignIn(false);
      const ipc = IpcClient.getInstance();
      const result = await ipc.getCompassUsage();
      if (!result.ok) {
        setPercentRemaining(null);
        setTokensUsedThisMonth(null);
        setMonthlyLimit(null);
        setTier(null);
        if (result.reason === "not_authenticated") {
          setNeedsSignIn(true);
        } else {
          setNeedsSignIn(false);
          if (result.reason === "network_error") {
            setError(
              result.message ??
                "Unable to load Compass usage (network). You can keep using the app; limits refresh when online.",
            );
          } else {
            setError(result.message ?? "Could not load usage");
          }
        }
        return;
      }
      const { tokensUsedThisMonth: used, monthlyLimit: limit, tier: t } = result;
      setTokensUsedThisMonth(used);
      setMonthlyLimit(limit);
      setTier(t);
      if (limit != null && limit > 0) {
        setPercentRemaining(((limit - used) / limit) * 100);
      } else {
        setPercentRemaining(null);
      }
    } catch (e) {
      setNeedsSignIn(false);
      setError(e instanceof Error ? e.message : "Could not load usage");
      setPercentRemaining(null);
      setTier(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch, bump]);

  useEffect(() => {
    if (loading || monthlyLimit == null || monthlyLimit <= 0 || percentRemaining == null) {
      return;
    }
    const prev = prevPercentRef.current;
    prevPercentRef.current = percentRemaining;
    if (prev !== null) {
      for (const threshold of [50, 25, 10] as const) {
        const key = `remain-${threshold}`;
        if (
          prev > threshold &&
          percentRemaining <= threshold &&
          !milestoneToastedRef.current.has(key)
        ) {
          milestoneToastedRef.current.add(key);
          toast.message(`Compass: about ${threshold}% of your monthly tokens remaining`, {
            duration: 6000,
          });
        }
      }
    }

    // Fix: Finding 5 — consumed % milestones for persistent inline banner (75% / 50% / 25% of quota used)
    const consumedPct = 100 - percentRemaining;
    const prevConsumed = prevConsumedRef.current;
    prevConsumedRef.current = consumedPct;
    if (prevConsumed === null) {
      return;
    }
    for (const threshold of [25, 50, 75] as const) {
      const key = `used-${threshold}`;
      if (
        prevConsumed < threshold &&
        consumedPct >= threshold &&
        !milestoneInlineRef.current.has(key)
      ) {
        milestoneInlineRef.current.add(key);
        setMilestoneBanner(
          `Compass: you've used about ${threshold}% of your monthly token quota. Add API keys in Settings or upgrade if you need more.`,
        );
      }
    }
  }, [percentRemaining, loading, monthlyLimit, setMilestoneBanner]);

  return {
    percentRemaining,
    tokensUsedThisMonth,
    monthlyLimit,
    tier,
    loading,
    error,
    needsSignIn,
    refetch,
  };
}
