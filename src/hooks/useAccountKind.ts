import { useCreditBalance } from "@/hooks/useCreditBalance";

/**
 * Who pays for Atlarix Core on this account, as the picker badges need it:
 *  - `pro`: has a monthly allowance (only Pro grants one since the Reviewer
 *    subscription was folded in on 2026-09-08) — Core reads "Included".
 *  - `payg`: no allowance but spendable credit — Core reads "Credits".
 *  - `free`: nothing to spend — Auto is free, pinned Core models are locked.
 *  - `unknown`: signed out or still loading. Never locks anything: a wrong
 *    "locked" on a paying account is worse than a moment of neutral badges.
 *
 * Read from the balance split rather than `useAuth().plan`, which is an
 * unshared hook that costs an IPC round trip per instance.
 */
export type AccountKind = "free" | "pro" | "payg" | "unknown";

export function accountKindFrom(
  balanceCents: number | null,
  grantedTotalCents: number | null,
): AccountKind {
  if (balanceCents == null) return "unknown";
  if ((grantedTotalCents ?? 0) > 0) return "pro";
  return balanceCents > 0 ? "payg" : "free";
}

export function useAccountKind(): AccountKind {
  const { balanceCents, grantedTotalCents } = useCreditBalance();
  return accountKindFrom(balanceCents, grantedTotalCents);
}
