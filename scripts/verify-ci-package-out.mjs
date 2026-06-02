#!/usr/bin/env node
/**
 * Fail fast when Electron Forge did not produce expected output (CI release builds).
 *
 * Windows CI uses ci:package + ci:installers (same as macOS/Linux); see docs/WINDOWS_RELEASE_CI.md.
 *
 * Usage:
 *   node scripts/verify-ci-package-out.mjs --stage make --platform darwin --arch arm64
 *   node scripts/verify-ci-package-out.mjs --stage package --platform linux --arch x64
 */
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const opts = { stage: "make", platform: process.platform, arch: process.arch };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--stage" && argv[i + 1]) opts.stage = argv[++i];
    else if (arg === "--platform" && argv[i + 1]) opts.platform = argv[++i];
    else if (arg === "--arch" && argv[i + 1]) opts.arch = argv[++i];
  }
  return opts;
}

function listFilesRecursive(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function formatBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${n} B`;
}

/** v9.0.0 Setup.exe ~360 MiB; v9.1.18 without packageAfterPrune ~145 MiB. */
const MIN_WIN_SETUP_BYTES = 200 * 1024 * 1024;

function findFilesNamed(dir, name, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findFilesNamed(full, name, out);
    else if (entry.isFile() && entry.name === name) out.push(full);
  }
  return out;
}

function verifyWindowsPackagedResources(packageDir) {
  const resourcesDir = path.join(packageDir, "resources");
  const appAsar = path.join(resourcesDir, "app.asar");
  if (!fs.existsSync(appAsar)) {
    return `missing ${path.relative(process.cwd(), appAsar)}`;
  }
  const grammarsDir = path.join(resourcesDir, "ast-grep-grammars");
  if (!fs.existsSync(grammarsDir)) {
    return `missing ${path.relative(process.cwd(), grammarsDir)} (packageAfterPrune may not have run)`;
  }
  const parserFiles = findFilesNamed(grammarsDir, "parser.so");
  if (parserFiles.length === 0) {
    return `no parser.so under ${path.relative(process.cwd(), grammarsDir)}`;
  }
  console.log(
    `OK: win32 resources app.asar + ast-grep-grammars (${parserFiles.length} parser.so)`,
  );
  return null;
}

function verifyWindowsSetupSize(makeFiles) {
  const setup = makeFiles.find(
    (f) => f.toLowerCase().endsWith(".exe") && path.basename(f).includes("Setup"),
  );
  if (!setup) {
    return "no Setup.exe under out/make";
  }
  const bytes = fs.statSync(setup).size;
  console.log(`OK: ${path.basename(setup)} size=${formatBytes(bytes)}`);
  if (bytes < MIN_WIN_SETUP_BYTES) {
    return (
      `${path.basename(setup)} too small (${formatBytes(bytes)} < ${formatBytes(MIN_WIN_SETUP_BYTES)}); ` +
      "packageAfterPrune likely skipped — compare with v9.0.0 ~360 MiB"
    );
  }
  return null;
}

async function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

async function main() {
  const { stage, platform, arch } = parseArgs(process.argv);
  const root = process.cwd();
  const outDir = path.join(root, "out");
  const appName = "Atlarix";

  console.log(
    `[verify-ci-package-out] stage=${stage} platform=${platform} arch=${arch}`,
  );

  if (!fs.existsSync(outDir)) {
    await fail(
      `Missing out/ after ${stage}. Search logs for [packageAfterPrune], [win-ci-package], or electron-forge Finalizing package.`,
    );
  }

  const packageDir = path.join(outDir, `${appName}-${platform}-${arch}`);
  if (!fs.existsSync(packageDir)) {
    const entries = fs.readdirSync(outDir);
    await fail(
      `Missing packaged app at ${packageDir}. Found under out/: ${entries.join(", ") || "(empty)"}`,
    );
  }

  if (platform === "darwin") {
    const appBundle = path.join(packageDir, `${appName}.app`);
    if (!fs.existsSync(appBundle)) {
      const entries = fs.readdirSync(packageDir);
      await fail(
        `Missing ${appName}.app under ${packageDir}. Found: ${entries.join(", ") || "(empty)"}`,
      );
    }
  }

  if (platform === "win32") {
    const resourceErr = verifyWindowsPackagedResources(packageDir);
    if (resourceErr) {
      await fail(resourceErr);
    }
  }

  if (stage === "make") {
    const makeDir = path.join(outDir, "make");
    if (!fs.existsSync(makeDir)) {
      await fail(
        `Missing out/make after make (packaged dir exists at ${packageDir}). Makers did not run — check hook.postMake in logs.`,
      );
    }
    const files = listFilesRecursive(makeDir);
    if (files.length === 0) {
      await fail("out/make exists but contains no distributable files");
    }
    console.log(`OK: ${files.length} file(s) under out/make`);
    for (const f of files.slice(0, 8)) {
      console.log(`  - ${path.relative(root, f)}`);
    }
    if (files.length > 8) console.log(`  ... and ${files.length - 8} more`);

    if (platform === "win32") {
      const sizeErr = verifyWindowsSetupSize(files);
      if (sizeErr) {
        await fail(sizeErr);
      }
    }
  }

  console.log(`OK: packaged app at ${packageDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
