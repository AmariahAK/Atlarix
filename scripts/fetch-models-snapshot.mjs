#!/usr/bin/env node
/**
 * Regenerate the bundled models.dev snapshot (`build/models-snapshot.json.gz`).
 *
 * The snapshot is the LAST tier of the catalog resolution chain in
 * `src/lib/models_dev.ts` (memory → disk cache → bundled snapshot → network).
 * Without it, a first run with no network shows an empty provider list and an
 * empty model picker, because there is no disk cache yet either.
 *
 * This is run MANUALLY (`npm run models:snapshot`) and the artifact is
 * COMMITTED — deliberately not fetched during packaging. Packaging must not
 * depend on models.dev being reachable; a CI network blip would otherwise fail
 * the build or, worse, ship an empty snapshot.
 *
 * Regenerate as part of the release runbook so shipped installers carry a
 * recent floor. Staleness is self-healing at runtime (the hourly refresh
 * replaces it on first successful fetch), so an old snapshot degrades
 * gracefully rather than breaking anything.
 */

import { gzipSync } from "node:zlib";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const OUT_PATH = path.join(REPO_ROOT, "build", "models-snapshot.json.gz");

const SOURCE_URL = `${process.env.ATLARIX_MODELS_URL ?? "https://models.dev"}/api.json`;

/** Sanity floor: a payload this small is a truncation or an error page, not the catalog. */
const MIN_PROVIDERS = 50;

async function main() {
  console.log(`Fetching ${SOURCE_URL} …`);
  const res = await fetch(SOURCE_URL, {
    headers: { "User-Agent": "Atlarix/1.0" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${SOURCE_URL}`);

  const text = await res.text();
  const data = JSON.parse(text);
  if (!data || typeof data !== "object") {
    throw new Error("Response was not a JSON object");
  }

  const providers = Object.keys(data);
  if (providers.length < MIN_PROVIDERS) {
    throw new Error(
      `Only ${providers.length} providers (expected >= ${MIN_PROVIDERS}) — refusing to write a truncated snapshot`,
    );
  }

  let models = 0;
  for (const p of Object.values(data)) {
    models += Object.keys(p?.models ?? {}).length;
  }

  // Re-serialize rather than gzipping the raw body: drops any incidental
  // whitespace and guarantees the bytes parse back to exactly what we validated.
  const gz = gzipSync(Buffer.from(JSON.stringify(data), "utf-8"), { level: 9 });

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, gz);

  const raw = Buffer.byteLength(text);
  console.log(
    `Wrote ${path.relative(REPO_ROOT, OUT_PATH)} — ${providers.length} providers, ${models} models ` +
      `(${(raw / 1e6).toFixed(1)} MB raw → ${(gz.length / 1e3).toFixed(0)} KB gzipped)`,
  );
  console.log("Remember to commit the snapshot.");
}

main().catch((e) => {
  console.error(
    `[models:snapshot] ${e instanceof Error ? e.message : String(e)}`,
  );
  process.exit(1);
});
