#!/usr/bin/env node
/**
 * Render packaging/homebrew/atlarix.rb.tmpl with a release's version and the
 * SHA-256 of each archive, read from SHA256SUMS-cli.txt.
 *
 * Usage: node scripts/ci/render-homebrew-formula.mjs <version> <SHA256SUMS-cli.txt> > atlarix.rb
 */
import fs from "node:fs";
import path from "node:path";

const [version, sumsFile] = process.argv.slice(2);
if (!version || !sumsFile) {
  console.error("usage: render-homebrew-formula.mjs <version> <SHA256SUMS-cli.txt>");
  process.exit(2);
}
const sums = Object.fromEntries(
  fs
    .readFileSync(sumsFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.trim().split(/\s+\*?/))
    .map(([sha, name]) => [name, sha]),
);
const need = {
  SHA_DARWIN_ARM64: "atlarix-cli-darwin-arm64.tar.gz",
  SHA_DARWIN_X64: "atlarix-cli-darwin-x64.tar.gz",
  SHA_LINUX_ARM64: "atlarix-cli-linux-arm64.tar.gz",
  SHA_LINUX_X64: "atlarix-cli-linux-x64.tar.gz",
};
let out = fs.readFileSync(path.join(import.meta.dirname, "../../packaging/homebrew/atlarix.rb.tmpl"), "utf8");
out = out.replaceAll("{{VERSION}}", version.replace(/^v/, ""));
for (const [key, file] of Object.entries(need)) {
  if (!sums[file]) {
    console.error(`render-homebrew-formula: no checksum for ${file} in ${sumsFile}`);
    process.exit(1);
  }
  out = out.replaceAll(`{{${key}}}`, sums[file]);
}
process.stdout.write(out);
