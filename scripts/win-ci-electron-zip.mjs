/**
 * Windows CI: verify Electron distro zip and extract with PowerShell (not extract-zip).
 * Patches @electron/packager/dist/unzip.js on GHA win32 where extract-zip stalls (~528 KiB partial).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const PREFIX = "[win-ci-electron-zip]";

function formatBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}

function directoryStats(target, opts = {}) {
  const maxFiles = opts.maxFiles ?? 80_000;
  const started = Date.now();
  let bytes = 0;
  let files = 0;
  let dirs = 0;
  let truncated = false;

  if (!fs.existsSync(target)) {
    return {
      bytes: 0,
      files: 0,
      dirs: 0,
      truncated: false,
      exists: false,
      walkMs: 0,
    };
  }

  const st = fs.statSync(target);
  if (!st.isDirectory()) {
    return {
      bytes: st.size,
      files: 1,
      dirs: 0,
      truncated: false,
      exists: true,
      walkMs: Date.now() - started,
    };
  }

  const stack = [target];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (files >= maxFiles) {
        truncated = true;
        break;
      }
      const full = path.join(dir, e.name);
      try {
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          dirs++;
          stack.push(full);
        } else if (e.isFile()) {
          bytes += fs.statSync(full).size;
          files++;
        }
      } catch {
        /* skip */
      }
    }
    if (truncated) break;
  }

  return {
    bytes,
    files,
    dirs,
    truncated,
    exists: true,
    walkMs: Date.now() - started,
  };
}

/** electron-v38.x win32-x64.zip is ~110MB+; reject truncated cache artifacts. */
export const MIN_ELECTRON_ZIP_BYTES = 80 * 1024 * 1024;

/** Unpacked Electron win32 x64 is ~150MB+; catch failed Expand-Archive early. */
export const MIN_ELECTRON_UNPACKED_BYTES = 100 * 1024 * 1024;

const require = createRequire(import.meta.url);
const { downloadArtifact } = require("@electron/get");

/**
 * @returns {string}
 */
export function resolveElectronCacheRoot(cwd = process.cwd()) {
  return process.env.ELECTRON_CACHE || path.join(cwd, ".cache", "electron");
}

/**
 * @param {{ version: string, platform: string, arch: string, cacheRoot?: string }} opts
 * @returns {Promise<string>} absolute path to zip
 */
export async function resolveElectronZipPath(opts) {
  const cacheRoot = opts.cacheRoot ?? resolveElectronCacheRoot();
  fs.mkdirSync(cacheRoot, { recursive: true });

  const zipPath = await downloadArtifact({
    version: opts.version,
    platform: opts.platform,
    arch: opts.arch,
    artifactName: "electron",
    cacheRoot,
  });

  return zipPath;
}

/**
 * @param {string} zipPath
 * @param {{ minBytes?: number }} [opts]
 */
export function verifyElectronZip(zipPath, opts = {}) {
  const minBytes = opts.minBytes ?? MIN_ELECTRON_ZIP_BYTES;
  if (!fs.existsSync(zipPath)) {
    throw new Error(`${PREFIX} zip missing: ${zipPath}`);
  }
  const st = fs.statSync(zipPath);
  if (!st.isFile()) {
    throw new Error(`${PREFIX} not a file: ${zipPath}`);
  }
  console.log(
    `${PREFIX} zip ${path.basename(zipPath)} size=${formatBytes(st.size)} path=${zipPath}`,
  );
  if (st.size < minBytes) {
    throw new Error(
      `${PREFIX} zip too small (${formatBytes(st.size)} < ${formatBytes(minBytes)}); cache may be corrupt — delete and re-download`,
    );
  }
  return { bytes: st.size, path: zipPath };
}

/**
 * @param {string} zipPath
 * @param {string} targetDir
 */
export function expandZipPowerShell(zipPath, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  const zipLiteral = zipPath.replace(/'/g, "''");
  const destLiteral = targetDir.replace(/'/g, "''");
  const cmd = `Expand-Archive -LiteralPath '${zipLiteral}' -DestinationPath '${destLiteral}' -Force`;
  console.log(`${PREFIX} Expand-Archive → ${targetDir}`);

  const pwsh7 = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  const exe =
    process.env.ATLARIX_PWSH_PATH ||
    (fs.existsSync(pwsh7) ? pwsh7 : null) ||
    "pwsh";
  const args = ["-NoProfile", "-Command", cmd];

  const started = Date.now();
  const result = spawnSync(exe, args, { stdio: "inherit", windowsHide: true });
  const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);

  if (result.error) {
    throw new Error(
      `${PREFIX} Expand-Archive spawn failed: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `${PREFIX} Expand-Archive exited ${result.status ?? "?"} after ${elapsedSec}s (signal=${result.signal ?? "none"})`,
    );
  }
  console.log(`${PREFIX} Expand-Archive OK (${elapsedSec}s)`);
}

/**
 * @param {string} targetDir
 * @param {{ minBytes?: number }} [opts]
 */
export function verifyUnpackedElectron(targetDir, opts = {}) {
  const minBytes = opts.minBytes ?? MIN_ELECTRON_UNPACKED_BYTES;
  const stats = directoryStats(targetDir);
  const truncNote = stats.truncated
    ? " (walk truncated — increase maxFiles)"
    : "";
  console.log(
    `${PREFIX} unpacked ${targetDir}: ${formatBytes(stats.bytes)} files=${stats.files} dirs=${stats.dirs}${truncNote}`,
  );
  if (stats.truncated) {
    throw new Error(
      `${PREFIX} unpacked directory walk truncated; cannot verify full extract`,
    );
  }
  if (stats.bytes < minBytes) {
    throw new Error(
      `${PREFIX} unpacked tree too small (${formatBytes(stats.bytes)} < ${formatBytes(minBytes)})`,
    );
  }
  const exe = path.join(targetDir, "electron.exe");
  if (!fs.existsSync(exe)) {
    throw new Error(`${PREFIX} missing electron.exe under ${targetDir}`);
  }
  return stats;
}

/**
 * Verify zip exists and meets size threshold; logs path.
 * @param {{ version: string, platform: string, arch: string, cacheRoot?: string }} opts
 */
export async function ensureElectronZipReady(opts) {
  const zipPath = await resolveElectronZipPath(opts);
  verifyElectronZip(zipPath);
  return zipPath;
}

let patchInstalled = false;

/** Replace extract-zip with PowerShell on Windows GHA before packager runs. */
export function installWindowsCiElectronExtractPatch() {
  if (patchInstalled) return;
  const usePwshExtract =
    process.platform === "win32" &&
    (process.env.GITHUB_ACTIONS === "true" ||
      process.env.ATLARIX_WIN_PWSHELL_EXTRACT === "1");
  if (!usePwshExtract) return;

  const unzipMod = require("@electron/packager/dist/unzip.js");

  unzipMod.extractElectronZip = async (zipPath, targetDir) => {
    console.log(
      `${PREFIX} patch extract ${path.basename(zipPath)} → ${targetDir}`,
    );
    verifyElectronZip(zipPath);
    expandZipPowerShell(zipPath, targetDir);
    verifyUnpackedElectron(targetDir);
  };

  patchInstalled = true;
  console.log(
    `${PREFIX} installed PowerShell extract patch (extract-zip bypassed on Windows CI)`,
  );
}

async function cliVerify() {
  const {
    getElectronVersion,
  } = require("@electron-forge/core-utils/dist/electron-version.js");
  const cwd = process.cwd();
  const pkg = JSON.parse(
    fs.readFileSync(path.join(cwd, "package.json"), "utf8"),
  );
  const version = await getElectronVersion(cwd, pkg);
  const cacheRoot = resolveElectronCacheRoot(cwd);
  console.log(`${PREFIX} --verify electron=${version} cacheRoot=${cacheRoot}`);
  await ensureElectronZipReady({
    version,
    platform: "win32",
    arch: "x64",
    cacheRoot,
  });
  console.log(`${PREFIX} --verify OK`);
}

const isCliMain =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (isCliMain) {
  if (!process.argv.includes("--verify")) {
    console.error(
      `${PREFIX} usage: node scripts/win-ci-electron-zip.mjs --verify`,
    );
    process.exit(1);
  }
  cliVerify().catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
