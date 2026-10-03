/**
 * A provider API key held in memory for this process only: the cloud agent's
 * own-key runs (`atlarix --api-key-file`). Like the pinned Core token
 * (core_proxy.ts), it never goes into `process.env` (the agent's shell commands
 * inherit that) nor into user-settings.json (the agent can read files). It wins
 * over settings, the database and the environment in getModelClient.
 */
const pinned = new Map<string, string>();

export function setPinnedProviderKey(providerId: string, key: string | null): void {
  const k = key?.trim();
  if (k) pinned.set(providerId, k);
  else pinned.delete(providerId);
}

export function getPinnedProviderKey(providerId: string): string | undefined {
  return pinned.get(providerId);
}

/** An own-key run: it must never fall back to Atlarix Core (that bills the account). */
export function isOwnKeyRun(): boolean {
  return pinned.size > 0;
}
