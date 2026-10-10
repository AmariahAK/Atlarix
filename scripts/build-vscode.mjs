#!/usr/bin/env node
/**
 * Builds the VS Code extension (packages/vscode) and, with --target, packs it.
 *
 *   node scripts/build-vscode.mjs                      → packages/vscode/dist/
 *   node scripts/build-vscode.mjs --target darwin-arm64 --cli dist-bun/atlarix
 *       → also copies that CLI binary to packages/vscode/bin/ and writes
 *         dist-vscode/atlarix-<target>-<version>.vsix
 *
 * Two bundles: the extension host (Node, CommonJS, `vscode` left to the
 * editor) and the chat webview (browser). The ACP SDK is bundled in; the VSIX
 * carries no node_modules.
 *
 * VSIX targets are VS Code's platform names (win32-x64, darwin-arm64,
 * linux-x64, alpine-x64…), mapped from the CLI's (scripts/cli-targets.mjs) by
 * the release workflow.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = path.join(root, "packages", "vscode");
const dist = path.join(pkgDir, "dist");
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const target = flag("--target");
const cli = flag("--cli");

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const common = {
  bundle: true,
  minify: !args.includes("--dev"),
  sourcemap: args.includes("--dev") ? "inline" : false,
  logLevel: "warning",
  alias: { "@": path.join(root, "src") },
  legalComments: "none",
};

await build({
  ...common,
  entryPoints: [path.join(pkgDir, "src", "extension.ts")],
  outfile: path.join(dist, "extension.js"),
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
});

await build({
  ...common,
  entryPoints: { webview: path.join(pkgDir, "webview", "main.ts") },
  outdir: dist,
  platform: "browser",
  format: "iife",
  target: "es2022",
});
fs.copyFileSync(path.join(pkgDir, "webview", "style.css"), path.join(dist, "webview.css"));
fs.copyFileSync(path.join(root, "assets", "rix", "rix-glyph.svg"), path.join(pkgDir, "media", "rix-glyph.svg"));
console.log(`built ${path.relative(root, dist)}`);

if (target) {
  const bin = path.join(pkgDir, "bin");
  fs.rmSync(bin, { recursive: true, force: true });
  if (cli) {
    fs.mkdirSync(bin, { recursive: true });
    const exe = target.startsWith("win32") ? "atlarix.exe" : "atlarix";
    fs.copyFileSync(path.resolve(cli), path.join(bin, exe));
    if (!target.startsWith("win32")) fs.chmodSync(path.join(bin, exe), 0o755);
  }
  const version = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).version;
  const outDir = path.join(root, "dist-vscode");
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `atlarix-${target}-${version}.vsix`);
  execFileSync(
    "npx",
    ["--yes", "@vscode/vsce@4.0.0", "package", "--no-dependencies", "--allow-missing-repository", "--target", target, "--out", out],
    { cwd: pkgDir, stdio: "inherit", shell: process.platform === "win32" },
  );
  console.log(`packed ${path.relative(root, out)}`);
}
