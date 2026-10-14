/**
 * The MCP marketplace catalog, synced from the official MCP Registry.
 *
 * CACHE, DON'T PROXY. The registry is a preview service and a search can hang
 * for a minute, so nothing a user does waits on it: the catalog is synced in
 * the background (hourly, like `models_dev.ts`) and searched locally. If the
 * registry is down or slow, the marketplace keeps working on what it has.
 *
 * Resolution order: memory → disk cache (`<userData>/cache/mcp-registry.json`,
 * shared by the app and the CLI) → the snapshot shipped with the build
 * (`build/mcp-registry-snapshot.json.gz`, `npm run mcp:snapshot`) → the
 * Verified servers' built-in fallbacks. A sync after the first only asks for
 * what changed since the last one (`updated_since`), which also reports
 * deletions, so a removed or deprecated server drops out.
 *
 * The normalising, search and install logic is pure and lives in
 * `src/shared/mcp-catalog.ts`.
 *
 * MEMORY. The registry holds tens of thousands of servers (~20 MB of JSON),
 * and the app, the CLI and every editor's ACP agent are separate processes on
 * the same machine. So nothing is loaded at startup unless a sync is due, a
 * search ranks a light index and builds full cards only for the page it
 * returns, and the whole catalog is let go after a few idle minutes.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import log from "electron-log";
import { app } from "electron";
import { getUserDataPath } from "@/paths/paths";
import {
  MCP_REGISTRY_BASE_URL,
  displayTitle,
  isListableRecord,
  normalizeRegistryServer,
  searchCatalog,
  slimRegistryServer,
  verifiedEntries,
  VERIFIED_MCP_SERVERS,
  type CatalogEntry,
  type CatalogSearchItem,
  type RegistryRecord,
  type RegistryServer,
} from "@/shared/mcp-catalog";

const logger = log.scope("mcp-registry");

const REGISTRY_URL = process.env.ATLARIX_MCP_REGISTRY_URL ?? MCP_REGISTRY_BASE_URL;
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const CACHE_FRESH_MS = 5 * 60 * 1000;
const PAGE_TIMEOUT_MS = 30_000;
const PAGE_RETRIES = 2;
/** A sync that needs more pages than this is runaway, not a registry. */
const MAX_PAGES = 400;
const OFFICIAL = "io.modelcontextprotocol.registry/official";
/** The catalog is dropped from memory this long after its last use. */
const IDLE_RELEASE_MS = 5 * 60 * 1000;

interface CatalogFile {
  version: 1;
  /** Newest `updatedAt` seen (registry clock), the next sync's `updated_since`. */
  syncedAt: string;
  records: RegistryRecord[];
}

interface CatalogState {
  syncedAt: string;
  records: Map<string, RegistryRecord>;
  /** What search ranks: one light item per listable server, Verified first. Built lazily. */
  index: CatalogSearchItem[] | null;
  /** Remote URL / host / package id → registry name, for servers added without one. Built lazily. */
  lookup?: { byUrl: Map<string, string>; byHost: Map<string, string>; byPackage: Map<string, string> } | null;
}

let state: CatalogState | null = null;
let loading: Promise<CatalogState> | null = null;
let refreshing: Promise<void> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/** Keep the catalog in memory a little longer; drop it once nobody is browsing. */
function touch(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!refreshing) state = null;
    idleTimer = null;
  }, IDLE_RELEASE_MS);
  idleTimer.unref?.();
}

function toState(file: CatalogFile): CatalogState {
  const records = new Map<string, RegistryRecord>();
  for (const r of file.records ?? []) {
    if (r?.server?.name) records.set(r.server.name, r);
  }
  return { syncedAt: file.syncedAt ?? "", records, index: null };
}

function isCatalogFile(x: unknown): x is CatalogFile {
  return (
    !!x &&
    typeof x === "object" &&
    (x as CatalogFile).version === 1 &&
    Array.isArray((x as CatalogFile).records)
  );
}

// ─── Disk cache ─────────────────────────────────────────────────────────────

function getCachePath(): string {
  return path.join(getUserDataPath(), "cache", "mcp-registry.json");
}

async function loadFromCache(): Promise<CatalogState | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(getCachePath(), "utf-8"));
    if (isCatalogFile(parsed) && parsed.records.length > 0) return toState(parsed);
  } catch {
    // Missing or unreadable: the snapshot is next.
  }
  return null;
}

async function getCacheAgeMs(): Promise<number | null> {
  try {
    return Date.now() - (await fs.stat(getCachePath())).mtimeMs;
  } catch {
    return null;
  }
}

/** Atomic: temp file + rename, so a reader never sees half a catalog. */
async function saveToCache(s: CatalogState): Promise<void> {
  const cachePath = getCachePath();
  const tempPath = `${cachePath}.${process.pid}.tmp`;
  const file: CatalogFile = {
    version: 1,
    syncedAt: s.syncedAt,
    records: [...s.records.values()],
  };
  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(tempPath, JSON.stringify(file), "utf-8");
    await fs.rename(tempPath, cachePath);
  } catch (e) {
    logger.warn("Failed to save the MCP registry cache", e);
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

// ─── Bundled snapshot ───────────────────────────────────────────────────────

function resolveSnapshotPath(): string {
  const override = process.env.ATLARIX_MCP_REGISTRY_SNAPSHOT;
  if (override) return override;
  try {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, "mcp-registry-snapshot.json.gz");
    }
    return path.join(app.getAppPath(), "build", "mcp-registry-snapshot.json.gz");
  } catch {
    return path.join(process.cwd(), "build", "mcp-registry-snapshot.json.gz");
  }
}

async function loadBundledSnapshot(): Promise<CatalogState | null> {
  try {
    const parsed = JSON.parse(
      gunzipSync(await fs.readFile(resolveSnapshotPath())).toString("utf-8"),
    );
    if (isCatalogFile(parsed) && parsed.records.length > 0) {
      logger.info(`Using the bundled snapshot (${parsed.records.length} servers)`);
      return toState(parsed);
    }
  } catch {
    // None shipped: the Verified fallbacks still show.
  }
  return null;
}

async function loadState(): Promise<CatalogState> {
  touch();
  if (state) return state;
  if (!loading) {
    loading = (async () =>
      (await loadFromCache()) ??
      (await loadBundledSnapshot()) ?? { syncedAt: "", records: new Map(), index: null })().finally(
      () => {
        loading = null;
      },
    );
  }
  state = await loading;
  return state;
}

// ─── Sync ───────────────────────────────────────────────────────────────────

interface RegistryPage {
  servers?: Array<{
    server?: RegistryServer & { $schema?: string; _meta?: unknown };
    _meta?: Record<string, { status?: string; updatedAt?: string }>;
  }>;
  metadata?: { nextCursor?: string };
}

async function fetchPage(params: URLSearchParams): Promise<RegistryPage> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= PAGE_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoff = 500 * 2 ** (attempt - 1);
      await new Promise((r) => setTimeout(r, backoff + Math.random() * backoff));
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
    try {
      const res = await fetch(`${REGISTRY_URL}/v0.1/servers?${params}`, {
        headers: { "User-Agent": "Atlarix/1.0", Accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as RegistryPage;
    } catch (e) {
      lastError = e;
      if (e instanceof Error && e.name === "AbortError") throw e;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** `updated_since` a minute early: re-reading an entry is harmless, missing one is not. */
function sinceParam(syncedAt: string): string | null {
  const t = Date.parse(syncedAt);
  if (!Number.isFinite(t)) return null;
  return new Date(t - 60_000).toISOString();
}

/**
 * One sync. Changes are applied only when every page arrived, so a failure
 * half-way leaves the catalog exactly as it was.
 */
async function syncOnce(): Promise<void> {
  const current = await loadState();
  const since = sinceParam(current.syncedAt);
  const updates = new Map<string, RegistryRecord | null>();
  let newest = current.syncedAt;
  let cursor: string | undefined;
  let pages = 0;
  do {
    const params = new URLSearchParams({ version: "latest", limit: "100" });
    if (since) params.set("updated_since", since);
    if (cursor) params.set("cursor", cursor);
    const page = await fetchPage(params);
    for (const item of page.servers ?? []) {
      const server = item.server;
      if (!server?.name) continue;
      const meta = item._meta?.[OFFICIAL] ?? {};
      if (meta.updatedAt && meta.updatedAt > newest) newest = meta.updatedAt;
      if (meta.status !== "active") {
        updates.set(server.name, null);
        continue;
      }
      // An entry Atlarix cannot install is dropped like a deleted one.
      const slim = slimRegistryServer(server);
      updates.set(server.name, slim ? { server: slim, status: "active", updatedAt: meta.updatedAt } : null);
    }
    cursor = page.metadata?.nextCursor;
    if (++pages >= MAX_PAGES) throw new Error("MCP registry sync ran past its page limit");
  } while (cursor);

  // A full sync replaces the set: anything it did not return is gone.
  const records = since ? new Map(current.records) : new Map<string, RegistryRecord>();
  for (const [name, r] of updates) {
    if (r) records.set(name, r);
    else records.delete(name);
  }
  state = { syncedAt: newest, records, index: null, lookup: null };
  await saveToCache(state);
  logger.info(
    `Synced ${updates.size} change(s) in ${pages} page(s); ${records.size} servers (${since ? "incremental" : "full"})`,
  );
}

/** Sync now. Concurrent callers share one sync; a failure keeps the old catalog. */
export async function refreshMcpRegistry(): Promise<void> {
  if (!refreshing) {
    refreshing = syncOnce()
      .catch((e) => {
        logger.warn("MCP registry sync failed; keeping the cached catalog", e);
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

/** Start the hourly sync. Call once per process, next to `startModelsDevRefresh`. */
export function startMcpRegistryRefresh(): void {
  if (refreshTimer) return;
  void (async () => {
    // A fresh cache needs nothing at startup, not even loading: search loads it.
    const age = await getCacheAgeMs();
    if (age !== null && age < CACHE_FRESH_MS) return;
    await refreshMcpRegistry();
  })();
  refreshTimer = setInterval(() => void refreshMcpRegistry(), REFRESH_INTERVAL_MS);
  refreshTimer.unref();
}

// ─── Reads ──────────────────────────────────────────────────────────────────

function buildIndex(s: CatalogState): CatalogSearchItem[] {
  const verifiedNames = new Set(VERIFIED_MCP_SERVERS.map((v) => v.name));
  const items: CatalogSearchItem[] = verifiedEntries(s.records).map((e) => ({
    name: e.name,
    title: e.title,
    description: e.description,
  }));
  for (const r of s.records.values()) {
    if (!isListableRecord(r) || verifiedNames.has(r.server.name)) continue;
    items.push({
      name: r.server.name,
      title: displayTitle(r.server),
      description: r.server.description ?? "",
    });
  }
  return items;
}

function entryFor(s: CatalogState, name: string): CatalogEntry | null {
  const verified = VERIFIED_MCP_SERVERS.find((v) => v.name === name);
  if (verified) return verifiedEntries(s.records).find((e) => e.name === name) ?? null;
  const r = s.records.get(name);
  if (!r || !isListableRecord(r)) return null;
  try {
    return normalizeRegistryServer(r.server);
  } catch {
    return null;
  }
}

export interface McpCatalogPage {
  entries: CatalogEntry[];
  total: number;
  /** When the catalog last changed upstream (registry clock); empty before any sync. */
  syncedAt: string;
}

export async function searchMcpCatalog(
  query: string,
  opts: { offset?: number; limit?: number } = {},
): Promise<McpCatalogPage> {
  const s = await loadState();
  s.index ??= buildIndex(s);
  const page = searchCatalog(s.index, query, opts);
  const entries = page.entries
    .map((i) => entryFor(s, i.name))
    .filter((e): e is CatalogEntry => e !== null);
  return { entries, total: page.total, syncedAt: s.syncedAt };
}

export async function getMcpCatalogEntry(name: string): Promise<CatalogEntry | null> {
  return entryFor(await loadState(), name);
}

/** The raw server, for `resolveInstall`. Verified ones fall back to their built-in copy. */
export async function getMcpRegistryServer(name: string): Promise<RegistryServer | null> {
  const s = await loadState();
  const r = s.records.get(name);
  const verified = VERIFIED_MCP_SERVERS.find((v) => v.name === name);
  if (r && isListableRecord(r)) {
    // A Verified entry whose registry copy has no streamable-http remote keeps its known URL.
    if (verified && !r.server.remotes?.some((x) => x.type === "streamable-http" && x.url)) {
      return { ...r.server, remotes: verified.fallback.remotes };
    }
    return r.server;
  }
  return verified?.fallback ?? null;
}

// ─── Which registry server is this? ─────────────────────────────────────────

const normUrl = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
};
/** `@scope/pkg@1.2.3` / `pkg==1.0` / `ghcr.io/x/y:1.0` → the bare id. */
const bareId = (spec: string) =>
  spec
    .trim()
    .replace(/==.*$/, "")
    .replace(/^(@?[^@]+)@.*$/, "$1")
    .replace(/:[^/]*$/, "")
    .toLowerCase();

function buildLookup(s: CatalogState): NonNullable<CatalogState["lookup"]> {
  const byUrl = new Map<string, string>();
  const byHost = new Map<string, string>();
  const byPackage = new Map<string, string>();
  const verified = new Set(VERIFIED_MCP_SERVERS.map((v) => v.name));
  const add = (map: Map<string, string>, key: string, name: string) => {
    // A Verified server wins its URL and host over any third-party copy.
    if (!key) return;
    if (!map.has(key) || verified.has(name)) map.set(key, name);
  };
  const servers = [
    ...[...s.records.values()].filter(isListableRecord).map((r) => r.server),
    ...VERIFIED_MCP_SERVERS.map((v) => v.fallback),
  ];
  for (const server of servers) {
    for (const r of server.remotes ?? []) {
      if (!r.url || r.url.includes("{")) continue;
      add(byUrl, normUrl(r.url), server.name);
      add(byHost, hostOf(r.url), server.name);
    }
    for (const p of server.packages ?? []) add(byPackage, bareId(p.identifier), server.name);
  }
  return { byUrl, byHost, byPackage };
}

/**
 * The registry server a stored server came from, when it has no registry name
 * of its own: a pasted `https://mcp.notion.com/mcp` is Notion, and
 * `npx -y @modelcontextprotocol/server-memory` is that package's server.
 */
export async function findCatalogNameFor(ref: {
  url?: string | null;
  command?: string | null;
  args?: string[] | null;
}): Promise<string | null> {
  const s = await loadState();
  s.lookup ??= buildLookup(s);
  if (ref.url) {
    return s.lookup.byUrl.get(normUrl(ref.url)) ?? s.lookup.byHost.get(hostOf(ref.url)) ?? null;
  }
  for (const a of [ref.command ?? "", ...(ref.args ?? [])]) {
    if (!a || a.startsWith("-")) continue;
    const hit = s.lookup.byPackage.get(bareId(a));
    if (hit) return hit;
  }
  return null;
}

/** For tests. */
export function resetMcpRegistryState(): void {
  state = null;
  loading = null;
  refreshing = null;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}
