#!/usr/bin/env node
/**
 * Stage one npm package per platform from the release's CLI archives:
 * `atlarix-<target>` with `bin/atlarix[.exe]` and the os/cpu/libc fields that
 * make npm install only the matching one. The `atlarix` package lists them as
 * optional dependencies (build-headless-npm.mjs) and runs whichever it finds.
 *
 * Usage: node scripts/build-cli-npm.mjs <dir with atlarix-cli-<target>/atlarix[.exe]> <out dir>
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_TARGETS } from "./cli-targets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [binDir, outDir] = process.argv.slice(2);
if (!binDir || !outDir) {
  console.error("usage: build-cli-npm.mjs <binaries dir> <out dir>");
  process.exit(2);
}
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
fs.rmSync(outDir, { recursive: true, force: true });
for (const t of CLI_TARGETS) {
  const from = path.join(binDir, `atlarix-cli-${t.name}`, t.exe);
  if (!fs.existsSync(from)) {
    console.error(`[build-cli-npm] missing ${from}`);
    process.exit(1);
  }
  const dir = path.join(outDir, `atlarix-${t.name}`);
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.copyFileSync(from, path.join(dir, "bin", t.exe));
  fs.chmodSync(path.join(dir, "bin", t.exe), 0o755);
  const pkg = {
    name: `atlarix-${t.name}`,
    version,
    description: `The Atlarix CLI for ${t.name}. Installed by the \`atlarix\` package; not meant to be installed directly.`,
    license: "PROPRIETARY",
    homepage: "https://atlarix.dev/cli",
    // The PUBLIC releases repository, as the `atlarix` package does: the app
    // repository is private, so pointing here gave npm a dead repository link.
    repository: { type: "git", url: "git+https://github.com/AmariahAK/atlarix-releases.git" },
    bugs: { url: "https://github.com/AmariahAK/atlarix-releases/issues" },
    os: [t.npm.os],
    cpu: [t.npm.cpu],
    ...(t.npm.libc ? { libc: [t.npm.libc] } : {}),
    files: ["bin"],
    publishConfig: { access: "public" },
  };
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`[build-cli-npm] staged ${pkg.name}@${version}`);
}
