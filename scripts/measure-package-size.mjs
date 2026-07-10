#!/usr/bin/env node
/**
 * Report packaged app size and top-level breakdown (post `npm run package`).
 * Usage: node scripts/measure-package-size.mjs [path-to-out-dir]
 */
import { execSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

/** Stream `asar list` and count lines matching a predicate (avoids ENOBUFS on large archives). */
function countAsarLines(asarPath, predicate) {
  return new Promise((resolve) => {
    const child = spawn("npx", ["--yes", "@electron/asar", "list", asarPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let count = 0;
    let leftover = "";
    child.stdout.on("data", (chunk) => {
      const text = leftover + chunk.toString();
      const lines = text.split("\n");
      leftover = lines.pop() ?? "";
      for (const line of lines) {
        if (predicate(line)) count++;
      }
    });
    child.on("close", () => {
      if (leftover && predicate(leftover)) count++;
      resolve(count);
    });
    child.on("error", () => resolve(-1));
  });
}

const outRoot = path.resolve(process.argv[2] ?? path.join(process.cwd(), "out"));

function duHuman(target) {
  try {
    return execSync(`du -sh "${target}"`, { encoding: "utf8" }).split("\t")[0].trim();
  } catch {
    return "?";
  }
}

async function findAppBundle(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && e.name.endsWith(".app")) return full;
    if (e.isDirectory()) {
      const nested = await findAppBundle(full);
      if (nested) return nested;
    }
  }
  return null;
}

async function listTopSizes(root, limit = 12) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const sizes = [];
  for (const e of entries) {
    const full = path.join(root, e.name);
    sizes.push({ name: e.name, size: duHuman(full) });
  }
  sizes.sort((a, b) => a.name.localeCompare(b.name));
  return sizes.slice(0, limit);
}

async function main() {
  let stat;
  try {
    stat = await fs.stat(outRoot);
  } catch {
    console.error(`Out directory not found: ${outRoot}`);
    console.error("Run: npm run package");
    process.exit(1);
  }
  if (!stat.isDirectory()) {
    console.error(`Not a directory: ${outRoot}`);
    process.exit(1);
  }

  console.log(`Out root: ${outRoot}`);
  console.log(`Total:    ${duHuman(outRoot)}`);

  const app = await findAppBundle(outRoot);
  if (!app) {
    console.log("No .app bundle found under out/ — listing top-level entries:");
    for (const row of await listTopSizes(outRoot, 20)) {
      console.log(`  ${row.size.padStart(8)}  ${row.name}`);
    }
    return;
  }

  console.log(`App:      ${app}`);
  console.log(`App size: ${duHuman(app)}`);

  const resources = path.join(app, "Contents", "Resources");
  const asar = path.join(resources, "app.asar");
  const unpacked = path.join(resources, "app.asar.unpacked");

  for (const label of [
    ["app.asar", asar],
    ["app.asar.unpacked", unpacked],
    ["Resources/git", path.join(resources, "git")],
    ["Resources/skills", path.join(resources, "src", "skills")],
  ]) {
    const [name, p] = label;
    try {
      await fs.access(p);
      console.log(`  ${duHuman(p).padStart(8)}  ${name}`);
    } catch {
      /* optional */
    }
  }

  console.log("\nResources breakdown:");
  try {
    for (const row of await listTopSizes(resources, 16)) {
      console.log(`  ${row.size.padStart(8)}  ${row.name}`);
    }
  } catch {
    /* ignore */
  }

  try {
    const [mapCount, scaffoldCount, playwrightCount] = await Promise.all([
      countAsarLines(asar, (l) => l.endsWith(".map")),
      countAsarLines(asar, (l) => l.startsWith("/scaffold")),
      countAsarLines(asar, (l) => l.toLowerCase().includes("playwright")),
    ]);
    console.log("\nAsar audit:");
    console.log(`  .map files:     ${mapCount >= 0 ? mapCount : "?"}`);
    console.log(`  /scaffold paths: ${scaffoldCount >= 0 ? scaffoldCount : "?"}`);
    console.log(`  playwright refs: ${playwrightCount >= 0 ? playwrightCount : "?"}`);
  } catch (err) {
    console.warn("Asar audit skipped:", err.message);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
