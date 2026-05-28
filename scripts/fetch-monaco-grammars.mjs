#!/usr/bin/env node
/**
 * Fetch minimal TextMate grammar JSON for Monaco tmLanguage highlighting.
 * Output: src/lib/monaco/grammars/{id}.json (gitignored; run on postinstall).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "src", "lib", "monaco", "grammars");

const VSCODE_RAW =
  "https://raw.githubusercontent.com/microsoft/vscode/main/extensions";

/** id → download URLs (first success wins) */
const GRAMMARS = [
  {
    id: "typescript",
    urls: [
      `${VSCODE_RAW}/typescript-basics/syntaxes/TypeScript.tmLanguage.json`,
    ],
  },
  {
    id: "javascript",
    urls: [`${VSCODE_RAW}/javascript/syntaxes/JavaScript.tmLanguage.json`],
  },
  {
    id: "python",
    urls: [
      `${VSCODE_RAW}/python/syntaxes/MagicPython.tmLanguage.json`,
      "https://raw.githubusercontent.com/MagicStack/MagicPython/master/grammars/MagicPython.tmLanguage.json",
    ],
  },
  {
    id: "rust",
    urls: [`${VSCODE_RAW}/rust/syntaxes/rust.tmLanguage.json`],
  },
  { id: "go", urls: [`${VSCODE_RAW}/go/syntaxes/go.tmLanguage.json`] },
  {
    id: "vue",
    urls: [
      "https://raw.githubusercontent.com/vuejs/language-tools/master/extensions/vscode/syntaxes/vue.tmLanguage.json",
    ],
  },
  {
    id: "svelte",
    urls: [
      "https://raw.githubusercontent.com/sveltejs/language-tools/refs/heads/master/packages/svelte-vscode/syntaxes/svelte.tmLanguage.json",
      "https://raw.githubusercontent.com/sveltejs/svelte/master/packages/svelte-vscode/syntaxes/svelte.tmLanguage.json",
    ],
  },
  { id: "yaml", urls: [`${VSCODE_RAW}/yaml/syntaxes/yaml.tmLanguage.json`] },
  {
    id: "toml",
    urls: [
      "https://raw.githubusercontent.com/tamasfe/taplo/master/editors/vscode/syntaxes/toml.tmLanguage.json",
      `${VSCODE_RAW}/ini/syntaxes/ini.tmLanguage.json`,
    ],
  },
  {
    id: "docker",
    urls: [`${VSCODE_RAW}/docker/syntaxes/docker.tmLanguage.json`],
  },
  { id: "json", urls: [`${VSCODE_RAW}/json/syntaxes/JSON.tmLanguage.json`] },
  {
    id: "markdown",
    urls: [`${VSCODE_RAW}/markdown-basics/syntaxes/markdown.tmLanguage.json`],
  },
];

async function download(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "atlarix-fetch-monaco-grammars" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
}

function tryCopyFromNodeModules(id) {
  const file = path.join(ROOT, "node_modules", "@shikijs", "langs", "dist", `${id}.mjs`);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, "utf-8");
  const match = raw.match(/JSON\.parse\("((?:\\.|[^"\\])*)"\)/);
  if (!match) return null;
  try {
    const grammar = JSON.parse(
      match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"),
    );
    return JSON.stringify(grammar);
  } catch {
    return null;
  }
}

async function fetchOne({ id, urls }) {
  const dest = path.join(OUT_DIR, `${id}.json`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 200) {
    console.log(`  skip ${id} (already present)`);
    return true;
  }

  for (const url of urls) {
    try {
      const body = await download(url);
      JSON.parse(body);
      fs.writeFileSync(dest, body, "utf-8");
      console.log(`  ok ${id} (${(body.length / 1024).toFixed(1)} KB)`);
      return true;
    } catch (err) {
      console.warn(`  warn ${id} ${url}: ${err.message}`);
    }
  }

  const copied = tryCopyFromNodeModules(id);
  if (copied) {
    fs.writeFileSync(dest, copied, "utf-8");
    console.log(`  ok ${id} (from node_modules fallback)`);
    return true;
  }

  console.warn(`  miss ${id} — Monaco built-in highlighting still applies`);
  return false;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const keep = path.join(OUT_DIR, ".gitkeep");
  if (!fs.existsSync(keep)) fs.writeFileSync(keep, "", "utf-8");

  console.log("fetch-monaco-grammars →", OUT_DIR);
  let ok = 0;
  for (const spec of GRAMMARS) {
    if (await fetchOne(spec)) ok++;
  }
  console.log(`fetch-monaco-grammars: ${ok}/${GRAMMARS.length} grammars ready`);
  console.log(
    "Optional richer highlighting: npm i monaco-editor-textmate monaco-textmate onigasm",
  );
}

main().catch((err) => {
  console.error("fetch-monaco-grammars failed:", err);
  process.exit(1);
});
