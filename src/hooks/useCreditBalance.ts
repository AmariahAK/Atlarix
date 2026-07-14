import { useCallback, useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { compassUsageBumpAtom } from "@/atoms/viewAtoms";

export interface CreditBalanceState {
  /** Prepaid Atlarix Core wallet balance in integer cents, or null when unknown. */
  balanceCents: number | null;
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
        setError("Credit balance is unavailable in this environment.");
        return;
      }
      const result = (await invoke("auth:get-credit-balance")) as
        | { ok: boolean; balanceCents: number; error?: string }
        | undefined;
      if (!result?.ok) {
        setBalanceCents(null);
        if (result?.error) {
          setError(result.error);
        } else {
          // RPC returned ok:false with no error → no authenticated user.
          setNeedsSignIn(true);
        }
        return;
      }
      setBalanceCents(Number(result.balanceCents ?? 0));
    } catch (e) {
      setBalanceCents(null);
      setError(e instanceof Error ? e.message : "Could not load credit balance");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch, bump]);

  return { balanceCents, loading, error, needsSignIn, refetch };
}
