#!/usr/bin/env node
/**
 * Regenerate the bundled MCP Registry snapshot (`build/mcp-registry-snapshot.json.gz`).
 *
 * The snapshot is the LAST tier of the marketplace catalog in
 * `src/lib/mcp/registry-catalog.ts` (memory → disk cache → bundled snapshot).
 * Without it, a first run with no network (or with the registry down — it is a
 * preview service) shows an empty marketplace, because there is no disk cache
 * yet either.
 *
 * Run MANUALLY (`npm run mcp:snapshot`) and COMMITTED, like the models.dev
 * snapshot: packaging must never depend on the registry being reachable.
 * Regenerate as part of the release runbook. A stale snapshot self-heals: the
 * first successful sync only fetches what changed since it.
 */

import { gunzipSync, gzipSync } from "node:zlib";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const OUT_PATH = path.join(REPO_ROOT, "build", "mcp-registry-snapshot.json.gz");

const BASE = process.env.ATLARIX_MCP_REGISTRY_URL ?? "https://registry.modelcontextprotocol.io";

/** Sanity floor: fewer than this is a truncation or an error page, not the registry. */
const MIN_SERVERS = 500;
const OFFICIAL = "io.modelcontextprotocol.registry/official";

async function page(cursor) {
  const u = new URL("/v0.1/servers", BASE);
  u.searchParams.set("version", "latest");
  u.searchParams.set("limit", "100");
  if (cursor) u.searchParams.set("cursor", cursor);
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(u, {
        headers: { "User-Agent": "Atlarix/1.0", Accept: "application/json" },
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${u}`);
      return await res.json();
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

// ─── Slimming ──────────────────────────────────────────────────────────────
// KEEP IN STEP with `slimRegistryServer` in src/shared/mcp-catalog.ts: the app
// slims what its hourly sync receives the same way, so a server looks the same
// whether it came from this snapshot or from a sync.
const RUNNERS = new Set(["npm", "pypi", "oci"]);
const trim = (s, n) => (typeof s !== "string" || !s ? undefined : s.length <= n ? s : `${s.slice(0, n - 1)}…`);

function slimInput(i) {
  const out = {};
  for (const k of ["name", "type", "value", "valueHint", "isRequired", "isSecret", "default", "choices", "placeholder", "format"]) {
    if (i[k] !== undefined) out[k] = i[k];
  }
  const d = trim(i.description, 120);
  if (d) out.description = d;
  if (i.variables) out.variables = Object.fromEntries(Object.entries(i.variables).map(([k, v]) => [k, slimInput(v)]));
  return out;
}

/** What the app keeps of a server, or null when Atlarix cannot install it. */
function slim(s) {
  const remotes = (s.remotes ?? [])
    .filter((r) => r?.type === "streamable-http" && r.url)
    .slice(0, 2)
    .map((r) => ({
      type: r.type,
      url: r.url,
      ...(r.headers?.length ? { headers: r.headers.map(slimInput) } : {}),
      ...(r.variables ? { variables: Object.fromEntries(Object.entries(r.variables).map(([k, v]) => [k, slimInput(v)])) } : {}),
    }));
  const packages = (s.packages ?? [])
    .filter((p) => p?.identifier && RUNNERS.has(p.registryType) && (!p.transport?.type || p.transport.type === "stdio"))
    .slice(0, 2)
    .map((p) => ({
      registryType: p.registryType,
      identifier: p.identifier,
      ...(p.version ? { version: p.version } : {}),
      ...(p.runtimeHint ? { runtimeHint: p.runtimeHint } : {}),
      ...(p.runtimeArguments?.length ? { runtimeArguments: p.runtimeArguments.map(slimInput) } : {}),
      ...(p.packageArguments?.length ? { packageArguments: p.packageArguments.map(slimInput) } : {}),
      ...(p.environmentVariables?.length ? { environmentVariables: p.environmentVariables.map(slimInput) } : {}),
    }));
  if (remotes.length === 0 && packages.length === 0) return null;
  const icon = s.icons?.find((i) => i?.src);
  const description = trim(s.description, 300);
  return {
    name: s.name,
    ...(s.title ? { title: s.title } : {}),
    ...(s.version ? { version: s.version } : {}),
    ...(description ? { description } : {}),
    ...(s.websiteUrl ? { websiteUrl: s.websiteUrl } : {}),
    ...(s.repository?.url ? { repository: { url: s.repository.url } } : {}),
    ...(icon ? { icons: [{ src: icon.src, ...(icon.mimeType ? { mimeType: icon.mimeType } : {}) }] } : {}),
    ...(remotes.length ? { remotes } : {}),
    ...(packages.length ? { packages } : {}),
  };
}

function write(records, syncedAt, pages) {
  if (records.length < MIN_SERVERS) {
    throw new Error(`Only ${records.length} servers (expected >= ${MIN_SERVERS}) — refusing to write a truncated snapshot`);
  }
  const payload = JSON.stringify({ version: 1, syncedAt, records });
  const gz = gzipSync(Buffer.from(payload, "utf-8"), { level: 9 });
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, gz);
  console.log(
    `Wrote ${path.relative(REPO_ROOT, OUT_PATH)}: ${records.length} servers` +
      (pages ? `, ${pages} pages` : "") +
      `, ${(payload.length / 1024).toFixed(0)} KB raw, ${(gz.length / 1024).toFixed(0)} KB gzipped (synced to ${syncedAt})`,
  );
}

async function main() {
  // `--reslim`: re-apply the slimming to the snapshot already on disk, with no
  // network (for when the slimming rules change between releases).
  if (process.argv.includes("--reslim")) {
    const old = JSON.parse(gunzipSync(fs.readFileSync(OUT_PATH)).toString("utf-8"));
    const records = [];
    for (const r of old.records ?? []) {
      const server = r?.server ? slim(r.server) : null;
      if (server) records.push({ server, status: "active", updatedAt: r.updatedAt });
    }
    write(records, old.syncedAt, 0);
    return;
  }
  const records = [];
  let syncedAt = "";
  let cursor;
  let pages = 0;
  do {
    const data = await page(cursor);
    pages++;
    for (const item of data.servers ?? []) {
      const meta = item?._meta?.[OFFICIAL] ?? {};
      if (meta.updatedAt && meta.updatedAt > syncedAt) syncedAt = meta.updatedAt;
      if (!item?.server?.name || meta.status !== "active") continue;
      const server = slim(item.server);
      if (server) records.push({ server, status: meta.status, updatedAt: meta.updatedAt });
    }
    cursor = data.metadata?.nextCursor;
    if (pages % 10 === 0) process.stdout.write(`  ${pages} pages, ${records.length} servers…\n`);
  } while (cursor);

  write(records, syncedAt, pages);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
