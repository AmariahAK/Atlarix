import { useQuery } from "@tanstack/react-query";
import { IpcClient } from "@/ipc/ipc_client";
import type { LanguageModel } from "@/ipc/ipc_types";

/**
 * The last list this window loaded, kept so the next launch has names to show
 * at once. Building the real list takes 10–20 s after launch, and until it
 * arrived every reply's label was a prettified raw id ("Claude Sonnet 5 5
 * (anthropic)"). Only a placeholder: the live list replaces it as soon as it
 * lands, and nothing decides anything on it.
 */
const CACHE_KEY = "atlarix.languageModelsByProviders.v1";

function readCached(): Record<string, LanguageModel[]> | undefined {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, LanguageModel[]>) : undefined;
  } catch {
    return undefined;
  }
}

function writeCached(data: Record<string, LanguageModel[]>): void {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch {
    // Full or unavailable storage: the next launch simply waits for the list.
  }
}

/** Refetch on focus only once the list is this old (see below). */
const FOCUS_REFRESH_AFTER_MS = 30_000;

/**
 * Fetches all available language models grouped by their provider IDs.
 *
 * @returns TanStack Query result object for the language models organized by provider.
 */
export function useLanguageModelsByProviders() {
  const ipcClient = IpcClient.getInstance();

  return useQuery<Record<string, LanguageModel[]>, Error>({
    queryKey: ["language-models-by-providers"],
    queryFn: async () => {
      const data = await ipcClient.getLanguageModelsByProviders();
      writeCached(data);
      return data;
    },
    placeholderData: readCached,
    // Building this list is expensive (DB + the full models.dev catalog for
    // every provider). Without a staleTime it refetches on every component mount
    // and window focus — and many per-message components subscribe to it, which
    // hammers the main thread. Model sets change rarely and the events that do
    // change them (provider CRUD, core-models refresh, the manual "Refresh model
    // list" button) invalidate this key explicitly, so a few-minute cache is safe.
    staleTime: 5 * 60_000,
    // Except one change no event here reports: a provider added or renamed in
    // the terminal (same profile) kept its old name in an open app until a
    // restart. Coming back to the window refetches the list once (one query,
    // however many components read it), at most every 30 s.
    refetchOnWindowFocus: (query) =>
      Date.now() - query.state.dataUpdatedAt > FOCUS_REFRESH_AFTER_MS ? "always" : false,
  });
}
