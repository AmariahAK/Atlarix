/**
 * Did the extension actually change since a previous git ref?
 *
 * ══ WHY THIS EXISTS ══
 *
 * The extension ships with every desktop release, but a Chrome Web Store
 * submission enters a HUMAN REVIEW QUEUE and cannot be recalled. Re-submitting
 * an unchanged extension on every desktop patch would be rude to the reviewers
 * and slow for us. So the zip is attached to every release; the submission is
 * conditional on this.
 *
 * ══ WHY THE INPUT LIST COMES FROM THE BUILD ══
 *
 * `packages/extension/dist/inputs.json` is written by build-extension.mjs from
 * esbuild's metafile, so it is the EXACT set of files that went into the
 * bundle. A path heuristic rooted at `packages/extension` would be wrong: 7 of
 * the 74 inputs live under `src/` (the shared page kernel, the a11y formatter),
 * and a kernel fix with no file touched inside the package is a real extension
 * change. Shipping a stale extension is the failure nobody sees until a user
 * hits it.
 *
 * ══ THE VERSION FIELD IS EXCLUDED, AND THAT IS THE WHOLE TRICK ══
 *
 * The extension's version now follows the app's, so `manifest.json` and the
 * package's `package.json` differ on EVERY release by construction. Compared
 * naively they would report "changed" every time and this check would be an
 * expensive no-op. They are compared with `version` normalised away, so a
 * version-only delta reads as what it is: nothing to submit.
 *
 * Usage: node scripts/extension-changed.mjs <previous-ref>
 * Prints `true` or `false`. Exits non-zero only on a real error.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prev = process.argv[2];
if (!prev) {
  console.error("usage: extension-changed.mjs <previous-ref>");
  process.exit(2);
}

const inputsFile = path.join(root, "packages/extension/dist/inputs.json");
if (!fs.existsSync(inputsFile)) {
  console.error(
    "dist/inputs.json is missing — run `npm run build:extension` first. " +
      "Without it this cannot tell a changed extension from an unchanged one, " +
      "and guessing in either direction is worse than failing.",
  );
  process.exit(2);
}
const inputs = JSON.parse(fs.readFileSync(inputsFile, "utf8"));

/** A file's content at a ref, or null when it did not exist there. */
function atRef(ref, file) {
  try {
    return execFileSync("git", ["show", `${ref}:${file}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** Strip the version field so a version-only bump does not read as a change. */
const VERSIONED = new Set([
  "packages/extension/manifest.json",
  "packages/extension/package.json",
]);
function normalise(file, text) {
  if (text === null || !VERSIONED.has(file)) return text;
  try {
    const json = JSON.parse(text);
    delete json.version;
    return JSON.stringify(json);
  } catch {
    return text;
  }
}

const changed = [];
for (const file of inputs) {
  const abs = path.join(root, file);
  const now = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
  const then = atRef(prev, file);
  if (normalise(file, now) !== normalise(file, then)) changed.push(file);
}

if (changed.length > 0) {
  console.error(
    `[extension-changed] ${changed.length} input(s) differ from ${prev}:\n  ` +
      changed.slice(0, 10).join("\n  ") +
      (changed.length > 10 ? `\n  …and ${changed.length - 10} more` : ""),
  );
}
console.log(changed.length > 0 ? "true" : "false");
