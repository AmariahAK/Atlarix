/**
 * Write the app's version into the extension's two version fields.
 *
 * WHY THE EXTENSION FOLLOWS THE APP (owner, 2026-09-17). It used to carry its
 * own line — 1.0.x against the app's 14.x — because it shipped on its own
 * cadence behind `ext-v*` tags. It now ships with every desktop release, so a
 * second version number bought nothing except the question "which app build is
 * this extension from". One number answers it.
 *
 * THIS IS A ONE-WAY DOOR AND THAT IS DELIBERATE. Chrome Web Store versions may
 * only increase, so having published 14.x there is no going back to 1.x. Noted
 * here because the next person to wonder why the extension is on version 14
 * deserves the reason in the file that does it.
 *
 * `--check` exits non-zero instead of writing, for CI.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const version = read(path.join(root, "package.json")).version;

const targets = [
  path.join(root, "packages/extension/manifest.json"),
  path.join(root, "packages/extension/package.json"),
  // The VS Code extension ships with every release too (release.yml build-vscode).
  path.join(root, "packages/vscode/package.json"),
];

let drifted = false;
for (const file of targets) {
  const json = read(file);
  if (json.version === version) continue;
  drifted = true;
  const rel = path.relative(root, file);
  if (check) {
    console.error(
      `[sync-extension-version] ${rel} says ${json.version}, app is ${version}`,
    );
    continue;
  }
  json.version = version;
  // Rewritten field-in-place rather than a whole-file reserialise: these files
  // are hand-edited and key order is meaningful to whoever reads them next.
  const raw = fs.readFileSync(file, "utf8");
  const next = raw.replace(
    /("version"\s*:\s*)"[^"]*"/,
    `$1${JSON.stringify(version)}`,
  );
  if (next === raw) {
    console.error(`[sync-extension-version] could not find a version field in ${rel}`);
    process.exit(1);
  }
  fs.writeFileSync(file, next);
  console.log(`[sync-extension-version] ${rel} -> ${version}`);
}

if (check && drifted) process.exit(1);
if (!drifted) console.log(`[sync-extension-version] already ${version}`);
