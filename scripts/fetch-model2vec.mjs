#!/usr/bin/env node
/**
 * Fetch the on-device Model2Vec static-embedding model (`potion-code-16M`) used
 * by the optional semantic-recall lane (src/lib/search/static-embeddings.ts).
 *
 * Downloads the model + tokenizer into assets/model2vec/ so forge can bundle it
 * via extraResource. No-op if already present. Non-fatal on failure (the app
 * falls back to Blueprint Tier-1 retrieval), mirroring scripts/fetch-ctags.mjs.
 *
 * Run: `npm run fetch-model2vec` (and before a release build that wants the
 * semantic lane). The files are NOT committed — they're a build artifact.
 */
import { mkdir, access, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "assets", "model2vec", "potion-code-16M");

// Hugging Face static-embedding model (CPU, ~30MB). model2vec format:
// model.safetensors (the vocab×dim table) + tokenizer.json + config.json.
const REPO = "minishlab/potion-code-16M";
const BASE = `https://huggingface.co/${REPO}/resolve/main`;
const FILES = ["model.safetensors", "tokenizer.json", "config.json"];

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (await exists(path.join(OUT_DIR, "model.safetensors"))) {
    console.log("[fetch-model2vec] model already present — skipping");
    return;
  }
  await mkdir(OUT_DIR, { recursive: true });
  for (const f of FILES) {
    const url = `${BASE}/${f}`;
    console.log(`[fetch-model2vec] downloading ${f}…`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(path.join(OUT_DIR, f), buf);
  }
  console.log(`[fetch-model2vec] done → ${OUT_DIR}`);
}

main().catch((e) => {
  // Non-fatal: the semantic lane stays off; Blueprint Tier-1 still works.
  console.warn(`[fetch-model2vec] skipped (${e.message}) — semantic recall disabled`);
  process.exit(0);
});
