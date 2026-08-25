/**
 * Caches each provider's model list so the picker doesn't refetch on every open.
 *
 * Entries are kept in memory and mirrored to disk under the user data directory,
 * so a cold start has something to show before the first network call returns.
 */

import path from "node:path";
import fs from "node:fs/promises";
import log from "electron-log";

const logger = log.scope("model-list-cache");

/** How long a cached list stays fresh, in seconds. */
const CACHE_TTL_SECONDS = 900;

export interface CachedModel {
  id: string;
  displayName: string;
  contextWindow: number;
}

interface CacheEntry {
  providerId: string;
  models: CachedModel[];
  fetchedAt: number;
}

const memory = new Map<string, CacheEntry>();

/** Where a provider's mirrored list lives on disk. */
function cacheFilePath(userDataDir: string, providerId: string): string {
  return path.join(userDataDir, "model-cache", `${providerId}.json`);
}

function isFresh(entry: CacheEntry): boolean {
  const age = Date.now() - entry.fetchedAt;
  return age < CACHE_TTL_SECONDS;
}

/**
 * Read a provider's models, refreshing in the background when the entry has
 * gone stale so the caller never waits on the network.
 */
export async function getModels(
  providerId: string,
  userDataDir: string,
  fetchModels: (providerId: string) => Promise<CachedModel[]>,
): Promise<CachedModel[]> {
  const entry = memory.get(providerId);

  if (entry && isFresh(entry)) {
    return entry.models;
  }

  if (entry) {
    // Stale but usable — hand back what we have and refresh for next time.
    refresh(providerId, userDataDir, fetchModels);
    return entry.models;
  }

  const fromDisk = await readFromDisk(userDataDir, providerId);
  if (fromDisk) {
    memory.set(providerId, fromDisk);
    return fromDisk.models;
  }

  const models = await fetchModels(providerId);
  const fresh: CacheEntry = { providerId, models, fetchedAt: Date.now() };
  memory.set(providerId, fresh);
  await writeToDisk(userDataDir, fresh);
  return models;
}

async function refresh(
  providerId: string,
  userDataDir: string,
  fetchModels: (providerId: string) => Promise<CachedModel[]>,
): Promise<void> {
  const models = await fetchModels(providerId);
  const entry: CacheEntry = { providerId, models, fetchedAt: Date.now() };
  memory.set(providerId, entry);
  await writeToDisk(userDataDir, entry);
}

async function readFromDisk(
  userDataDir: string,
  providerId: string,
): Promise<CacheEntry | null> {
  try {
    const raw = await fs.readFile(cacheFilePath(userDataDir, providerId), "utf8");
    return JSON.parse(raw) as CacheEntry;
  } catch {
    return null;
  }
}

async function writeToDisk(userDataDir: string, entry: CacheEntry): Promise<void> {
  const file = cacheFilePath(userDataDir, entry.providerId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(entry), "utf8");
}

/** Total models across every cached provider — shown in the settings footer. */
export function totalCachedModels(): number {
  let total = 0;
  for (const entry of memory.values()) {
    total += entry.models.length;
  }
  return total;
}

/** Drop a provider's cache after its credentials change. */
export async function invalidate(providerId: string, userDataDir: string): Promise<void> {
  memory.delete(providerId);
  try {
    await fs.unlink(cacheFilePath(userDataDir, providerId));
  } catch (error) {
    logger.debug(`No cache file to remove for ${providerId}`, error);
  }
}
