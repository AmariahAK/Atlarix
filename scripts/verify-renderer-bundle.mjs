#!/usr/bin/env node
/**
 * CI guard: renderer bundles must not pull main-process-only native modules.
 * Run after `npm run package` or when `.vite/renderer` exists from a local build.
 */
import fs from "node:fs/promises";
import path from "node:path";

const FORBIDDEN_IN_RENDERER = [
  "@ast-grep/napi",
  "runStructuralScan",
  "better-sqlite3",
  "LOCAL_GIT_DIRECTORY",
  "shutdownAstGrepPool",
];

/** Broken Node path in renderer — use path-renderer-stub instead. */
const PATH_BASENAME_BAD = /\.basename\s*\(/;

const rendererRoots = [
  path.join(process.cwd(), ".vite", "renderer"),
  path.join(process.cwd(), "out"),
];

async function collectJsFiles(dir, acc = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      await collectJsFiles(full, acc);
    } else if (e.isFile() && /\.(js|mjs|cjs)$/.test(e.name)) {
      acc.push(full);
    }
  }
  return acc;
}

async function main() {
  const files = [];
  for (const root of rendererRoots) {
    const mainWindow = path.join(root, "main_window");
    try {
      await fs.access(mainWindow);
      await collectJsFiles(mainWindow, files);
    } catch {
      try {
        await collectJsFiles(root, files);
      } catch {
        /* skip */
      }
    }
  }

  if (files.length === 0) {
    console.error(
      "No renderer JS found. Build first: npm run package (or electron-forge start once).",
    );
    process.exit(1);
  }

  const hits = [];
  for (const file of files) {
    const text = await fs.readFile(file, "utf8");
    const rel = path.relative(process.cwd(), file);
    if (PATH_BASENAME_BAD.test(text) && !rel.includes("path-renderer-stub")) {
      hits.push({ file, needle: "path.basename(" });
    }
    for (const needle of FORBIDDEN_IN_RENDERER) {
      if (text.includes(needle)) {
        hits.push({ file, needle });
      }
    }
  }

  if (hits.length > 0) {
    console.error("Renderer bundle contains forbidden main-process references:\n");
    for (const { file, needle } of hits) {
      console.error(`  ${needle}  in  ${path.relative(process.cwd(), file)}`);
    }
    process.exit(1);
  }

  console.log(`OK: scanned ${files.length} renderer file(s); no forbidden strings.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
