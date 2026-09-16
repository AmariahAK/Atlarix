/**
 * "Has this user brought their own key?" — and why the obvious hook cannot answer it.
 *
 * `useLanguageModelProviders().isAnyProviderSetup()` looks like the right call and is
 * not: `compass` (Atlarix Core) is a `type: "cloud"` entry in `CLOUD_PROVIDERS`, and
 * that predicate loops over cloud providers asking `isProviderSetup`. Core is set up
 * in every release build, so it returns `true` for a user with zero keys of their own.
 * `ProviderSettings.tsx`'s `providers.filter(isProviderSetup).length` has the same
 * inflation. Anything gating on "the user has a key" therefore has to exclude the
 * three providers that are configured without the user doing anything: Core, and the
 * two local runtimes.
 *
 * Derived from `useLanguageModelsByProviders` rather than from `providerSettings`
 * directly, for two reasons: it already accounts for keys held in the DB and in
 * environment variables (not just settings), and `useSettings` invalidates its query
 * key on every `providerSettings` write, so this stays fresh with no extra plumbing.
 */

import { useMemo } from "react";
import { useLanguageModelsByProviders } from "@/hooks/useLanguageModelsByProviders";

/**
 * Providers that are available without the user supplying anything, and so can never
 * be evidence of BYOK. `auto` is the routing pseudo-provider, not a real one.
 */
const NOT_BYOK = new Set(["compass", "ollama", "lmstudio", "auto"]);

export interface ByokProviderState {
  /** True once at least one non-Core, non-local provider has usable models. */
  hasByok: boolean;
  /** Provider ids the user supplied credentials for, in catalog order. */
  byokProviderIds: string[];
  /** Still fetching — callers should not decide anything yet. */
  isLoading: boolean;
}

export function useHasByokProvider(): ByokProviderState {
  const { data, isLoading } = useLanguageModelsByProviders();

  return useMemo(() => {
    const byokProviderIds = Object.entries(data ?? {})
      .filter(([id, models]) => !NOT_BYOK.has(id) && (models?.length ?? 0) > 0)
      .map(([id]) => id);

    return {
      hasByok: byokProviderIds.length > 0,
      byokProviderIds,
      isLoading,
    };
  }, [data, isLoading]);
}
