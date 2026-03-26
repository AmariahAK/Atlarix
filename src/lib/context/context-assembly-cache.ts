type CacheEntry<T> = {
  value: T;
  createdAt: number;
};

const CACHE_TTL_MS = 60_000;
const MAX_ENTRIES = 200;

const contextAssemblyCache = new Map<string, CacheEntry<unknown>>();

export function getContextAssemblyCache<T>(key: string): T | undefined {
  const hit = contextAssemblyCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.createdAt > CACHE_TTL_MS) {
    contextAssemblyCache.delete(key);
    return undefined;
  }
  return hit.value as T;
}

export function setContextAssemblyCache<T>(key: string, value: T): void {
  if (contextAssemblyCache.size >= MAX_ENTRIES) {
    const oldestKey = contextAssemblyCache.keys().next().value;
    if (oldestKey) contextAssemblyCache.delete(oldestKey);
  }
  contextAssemblyCache.set(key, { value, createdAt: Date.now() });
}

export function clearContextAssemblyCache(): void {
  contextAssemblyCache.clear();
}
