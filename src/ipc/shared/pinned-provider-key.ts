/**
 * A provider API key held in memory for this process only: a headless run's
 * key passed as a file (`atlarix --api-key-file`, the safe way in CI). Like
 * the pinned Core token (core_proxy.ts), it never goes into `process.env` (the
 * agent's shell commands inherit that) nor into user-settings.json (the agent
 * can read files). It wins
 * over settings, the database and the environment in getModelClient.
 */
const pinned = new Map<string, string>();
/** The pins that make this an own-key run (a headless run's key file). */
const ownKey = new Set<string>();

/**
 * `ownKeyRun: false`: the key an endpoint was started with (`--provider-url`
 * with --api-key or ATLARIX_DEV_API_KEY), used as given whatever the stored
 * copy says, in an interactive session that may still pick other models.
 */
export function setPinnedProviderKey(
  providerId: string,
  key: string | null,
  opts: { ownKeyRun?: boolean } = {},
): void {
  const k = key?.trim();
  if (k) {
    pinned.set(providerId, k);
    if (opts.ownKeyRun !== false) ownKey.add(providerId);
    else ownKey.delete(providerId);
  } else {
    pinned.delete(providerId);
    ownKey.delete(providerId);
  }
}

export function getPinnedProviderKey(providerId: string): string | undefined {
  return pinned.get(providerId);
}

/** An own-key run: it must never fall back to Atlarix Core (that bills the account). */
export function isOwnKeyRun(): boolean {
  return ownKey.size > 0;
}
