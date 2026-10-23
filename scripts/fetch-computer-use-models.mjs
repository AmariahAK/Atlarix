#!/usr/bin/env node
/**
 * Regenerate src/lib/computer/computer-use-models.json: the models LiteLLM's
 * catalog flags `supports_computer_use`, normalised the way the app looks
 * them up. The app refreshes this daily at run time; the snapshot is the floor
 * for a first run with no network.
 *
 *   node scripts/fetch-computer-use-models.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "src/lib/computer/computer-use-models.json");

// Same as normaliseModelId in src/lib/computer/catalog.ts (tested there
// against this file's output, so the two cannot drift silently).
function normaliseModelId(id) {
  return id
    .trim()
    .toLowerCase()
    .split("/")
    .pop()
    .replace(/@.*$/, "")
    .replace(/^(?:[a-z]{2,6}(?:-[a-z]{2,6})?\.)?anthropic\./, "")
    .replace(/-v\d+(?::\d+)?$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    .replace(/\./g, "-");
}

const res = await fetch(URL, { headers: { "User-Agent": "Atlarix/1.0" } });
if (!res.ok) throw new Error(`HTTP ${res.status} from ${URL}`);
const catalog = await res.json();
const ids = [
  ...new Set(
    Object.entries(catalog)
      .filter(([, row]) => row && typeof row === "object" && row.supports_computer_use === true)
      .map(([key]) => normaliseModelId(key)),
  ),
].sort();
if (ids.length === 0) throw new Error("no model is flagged supports_computer_use; the catalog changed shape");
fs.writeFileSync(out, `${JSON.stringify({ source: URL, fetchedAt: new Date().toISOString().slice(0, 10), ids }, null, 2)}\n`);
console.log(`${ids.length} models -> ${path.relative(root, out)}`);
