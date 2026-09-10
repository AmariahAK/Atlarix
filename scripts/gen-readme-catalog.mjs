#!/usr/bin/env node
/**
 * Fill the README's provider/model counts from the models snapshot we actually ship.
 *
 * The README claimed "145+ providers and 4,400+ tool-capable models" in three places.
 * `build/models-snapshot.json.gz` — the catalogue bundled into the app — carries 213 and
 * ~6,590. Wrong in the UNDERSTATING direction, which is why it survived: the claim never
 * became false, it just quietly stopped being true of the product.
 *
 * READS THE LOCAL SNAPSHOT, NOT THE NETWORK. That is the point. The snapshot is what the
 * app falls back to offline, so counting it means the README describes this build rather
 * than whatever models.dev happens to serve today — and the script stays deterministic and
 * runnable with no connectivity. Refresh order is therefore `npm run models:snapshot`
 * first, this second; both happen at release time.
 *
 * Figures are floored to a "+" value so the claim can never overstate between refreshes.
 *
 * Usage:
 *   node scripts/gen-readme-catalog.mjs          # write README.md if changed
 *   node scripts/gen-readme-catalog.mjs --check  # exit 1 if stale
 */
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const README = join(ROOT, "README.md");
const SNAPSHOT = join(ROOT, "build/models-snapshot.json.gz");

const floorTo = (n, step) => Math.floor(n / step) * step;

const catalog = JSON.parse(gunzipSync(readFileSync(SNAPSHOT)).toString("utf8"));
let providers = 0;
let toolModels = 0;
for (const p of Object.values(catalog)) {
  providers += 1;
  for (const m of Object.values(p.models ?? {})) if (m.tool_call) toolModels += 1;
}
if (providers < 100) {
  throw new Error(`snapshot has only ${providers} providers — refusing to publish a truncated count`);
}

const P = `${floorTo(providers, 10)}+`;
const M = `${floorTo(toolModels, 500).toLocaleString("en-US")}+`;

/**
 * Each marker names what goes inside it, because the three sites word the same fact
 * differently and a single global replace would flatten them into one phrasing.
 */
const BODIES = {
  providers: `${P} providers`,
  "providers-and-models": `${P} cloud providers and ${M} tool-capable models`,
};

let src = readFileSync(README, "utf8");
let out = src;
let found = 0;

for (const [key, body] of Object.entries(BODIES)) {
  const re = new RegExp(
    `(<!-- CATALOG:${key}:START[^>]*-->)[\\s\\S]*?(<!-- CATALOG:${key}:END -->)`,
    "g",
  );
  out = out.replace(re, (_m, a, b) => {
    found += 1;
    return `${a}${body}${b}`;
  });
}

if (found === 0) {
  console.error("[readme-catalog] no CATALOG markers found in README.md.");
  process.exit(1);
}

if (process.argv.includes("--check")) {
  if (out !== src) {
    console.error(
      `[readme-catalog] README counts are stale — expected "${BODIES.providers}" / ` +
        `"${BODIES["providers-and-models"]}".\n  Run: node scripts/gen-readme-catalog.mjs`,
    );
    process.exit(1);
  }
  console.log(`[readme-catalog] up to date — ${providers} providers, ${toolModels} tool-capable.`);
} else if (out === src) {
  console.log(`[readme-catalog] no change — ${BODIES["providers-and-models"]}.`);
} else {
  writeFileSync(README, out);
  console.log(`[readme-catalog] wrote ${BODIES["providers-and-models"]} across ${found} site(s).`);
}
