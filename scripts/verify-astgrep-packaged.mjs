#!/usr/bin/env node
/**
 * After `npm run package`, verify ast-grep natives and grammars are on a real filesystem path.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const outRoot = path.resolve(process.argv[2] ?? path.join(process.cwd(), "out"));

function findAppBundle(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && e.name.endsWith(".app")) return full;
    if (e.isDirectory()) {
      const nested = findAppBundle(full);
      if (nested) return nested;
    }
  }
  return null;
}

function platformPrebuildDir() {
  const os = { darwin: "macOS", linux: "Linux", win32: "Windows" }[process.platform];
  const arch = { x64: "X64", arm64: "ARM64" }[process.arch];
  if (!os || !arch) return null;
  return `prebuild-${os}-${arch}`;
}

function findNapiBindingNode(unpackedNm) {
  const astGrepScope = path.join(unpackedNm, "@ast-grep");
  if (!fs.existsSync(astGrepScope)) return null;
  const entries = fs.readdirSync(astGrepScope, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith("napi-")) continue;
    const dir = path.join(astGrepScope, e.name);
    const files = fs.readdirSync(dir);
    const nodeFile = files.find((f) => f.endsWith(".node"));
    if (nodeFile) return path.join(dir, nodeFile);
  }
  return null;
}

const app = findAppBundle(outRoot);
if (!app) {
  console.error(`No .app under ${outRoot} — run npm run package first`);
  process.exit(1);
}

const prebuildDir = platformPrebuildDir();
if (!prebuildDir) {
  console.error(`Unsupported platform ${process.platform}/${process.arch}`);
  process.exit(1);
}

const resources = path.join(app, "Contents", "Resources");
const parserName = "parser.so";
const unpackedNm = path.join(resources, "app.asar.unpacked", "node_modules");

let failed = false;

const napiNode = findNapiBindingNode(unpackedNm);
if (napiNode) {
  console.log(`OK: @ast-grep/napi binding → ${napiNode}`);
} else {
  console.error("Missing @ast-grep/napi platform .node under app.asar.unpacked/node_modules");
  failed = true;
}

const grammarSources = [
  {
    label: "extraResource ast-grep-grammars/python",
    p: path.join(resources, "ast-grep-grammars", "python", parserName),
  },
  {
    label: "extraResource ast-grep-grammars/go",
    p: path.join(resources, "ast-grep-grammars", "go", parserName),
  },
  {
    label: "unpacked lang-python",
    p: path.join(unpackedNm, "@ast-grep/lang-python", "prebuilds", prebuildDir, parserName),
  },
  {
    label: "unpacked lang-go",
    p: path.join(unpackedNm, "@ast-grep/lang-go", "prebuilds", prebuildDir, parserName),
  },
];

for (const lang of ["python", "go"]) {
  const hits = grammarSources.filter((s) => s.label.includes(lang) && fs.existsSync(s.p));
  if (hits.length === 0) {
    console.error(`Missing parser for ${lang} (need extraResource or unpacked prebuild)`);
    failed = true;
  } else {
    console.log(`OK: ${lang} → ${hits[0].p}`);
  }
}

const workerUnpacked = path.join(resources, "app.asar.unpacked", ".vite", "build", "astgrep_worker.js");
if (fs.existsSync(workerUnpacked)) {
  console.log("OK: astgrep_worker.js unpacked");
} else {
  console.warn("WARN: astgrep_worker.js not in app.asar.unpacked (may still be in asar)");
}

try {
  const unpackedDir = path.join(resources, "app.asar.unpacked");
  const mb = Number.parseInt(
    execSync(`du -sm "${unpackedDir}"`, { encoding: "utf8" }).split("\t")[0],
    10,
  );
  // v11: the slimmed runtime tree unpacks only real natives (ast-grep napi,
  // node-pty, better-sqlite3, keytar) ≈ 9MB. The old ~120MB+ expectation came
  // from the bloated full-tree install that also auto-unpacked junk natives.
  if (mb < 5) {
    console.warn(`WARN: app.asar.unpacked is only ~${mb}MB (expected ~9MB with natives)`);
  } else {
    console.log(`OK: app.asar.unpacked ~${mb}MB`);
  }
} catch {
  /* optional */
}

if (failed) {
  process.exit(1);
}

console.log("\nAll ast-grep packaged checks passed.");
