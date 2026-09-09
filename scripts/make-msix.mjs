#!/usr/bin/env node
/**
 * Build an MSIX package from the electron-forge packaged output.
 *
 * Runs AFTER `electron-forge package`, against `out/Atlarix-win32-<arch>/`.
 *
 * WHY NOT `@electron-forge/maker-appx`: its source imports `electron-windows-store`
 * (last published 2023, and not even a declared dependency of the maker), and its
 * default certificate path shells out to `makecert.exe`, which Microsoft removed
 * from the Windows SDK years ago. It also emits `.appx` only, with the manifest
 * mediated by that stale generator. We need exact manifest authority — the
 * `windows.protocol` declaration is load-bearing for OAuth and the Lemon Squeezy
 * return leg — so we drive the SDK tooling directly instead.
 *
 * The output is UNSIGNED by design. Signing happens on the maintainer's Windows
 * machine so no code-signing private key has to live in CI secrets; see
 * docs/MSIX_RUNBOOK.md. Microsoft re-signs at certification anyway, so the local
 * signature exists only to let Windows install the package for testing.
 *
 * Usage:
 *   node scripts/make-msix.mjs [--arch x64] [--upload]
 *
 *   --upload  additionally wrap the .msix in a .msixupload (a plain ZIP), which
 *             is what Visual Studio produces for Store submission. Partner Center
 *             also accepts a bare .msix for a single-architecture app, so this is
 *             optional until the upload page says otherwise.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const TAG = "make-msix";
const ROOT = process.cwd();
const APP = "Atlarix";
const EXECUTABLE = "atlarix.exe";

function parseArgs(argv) {
  const opts = { arch: "x64", upload: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--arch" && argv[i + 1]) opts.arch = argv[++i];
    else if (argv[i].startsWith("--arch="))
      opts.arch = argv[i].slice("--arch=".length);
    else if (argv[i] === "--upload") opts.upload = true;
  }
  return opts;
}

function fail(msg) {
  console.error(`::error::[${TAG}] ${msg}`);
  process.exit(1);
}

/**
 * Locate a Windows SDK tool. The SDK installs per-version under
 * `bin\<10.0.x.y>\<arch>\`, so pick the highest version present rather than
 * hardcoding one that a runner image may have moved past.
 */
function findSdkTool(exe) {
  const roots = [
    "C:\\Program Files (x86)\\Windows Kits\\10\\bin",
    "C:\\Program Files\\Windows Kits\\10\\bin",
  ];
  const candidates = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root)) {
      if (!entry.startsWith("10.")) continue;
      for (const arch of ["x64", "x86"]) {
        const candidate = path.join(root, entry, arch, exe);
        if (fs.existsSync(candidate))
          candidates.push({ version: entry, path: candidate });
      }
    }
    // Some older SDK layouts drop the tools directly in bin\<arch>\.
    for (const arch of ["x64", "x86"]) {
      const flat = path.join(root, arch, exe);
      if (fs.existsSync(flat)) candidates.push({ version: "0", path: flat });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) =>
    b.version.localeCompare(a.version, undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );
  return candidates[0].path;
}

/**
 * MSIX versions are four numeric parts and the Store RESERVES the fourth
 * (revision) — it must be 0 on submission. `14.27.0` becomes `14.27.0.0`.
 */
function toPackageVersion(semver) {
  const core = String(semver).split(/[-+]/)[0]; // drop any prerelease/build tag
  const parts = core.split(".").map((p) => Number(p));
  if (parts.length < 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    fail(
      `cannot derive an MSIX version from "${semver}" — need at least X.Y.Z of integers`,
    );
  }
  return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
}

/** Minimal store-only (uncompressed) ZIP writer — a .msixupload is just a ZIP. */
function writeStoredZip(destPath, entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = zlib.crc32 ? zlib.crc32(data) : crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method 0 = stored
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date (1996-01-01; deterministic)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  fs.writeFileSync(destPath, Buffer.concat([...chunks, centralBuf, end]));
}

/** CRC-32 fallback for Node versions without `zlib.crc32` (added in Node 20.15). */
function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++)
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ── main ────────────────────────────────────────────────────────────────────
const { arch, upload } = parseArgs(process.argv);

if (process.platform !== "win32") {
  fail(
    `MSIX packaging needs the Windows SDK's makeappx.exe, which is Windows-only. ` +
      `Run the "msix" GitHub workflow instead (workflow_dispatch) and download the artifact.`,
  );
}

const packageDir = path.join(ROOT, "out", `${APP}-win32-${arch}`);
const exePath = path.join(packageDir, EXECUTABLE);
if (!fs.existsSync(packageDir)) {
  fail(
    `packaged app not found at ${packageDir} — run \`electron-forge package\` first`,
  );
}
if (!fs.existsSync(exePath)) {
  fail(
    `${EXECUTABLE} missing from ${packageDir} — the AppxManifest Executable would not resolve`,
  );
}

const makeappx = findSdkTool("makeappx.exe");
if (!makeappx) {
  fail(
    `makeappx.exe not found. Install the Windows SDK (the "MSIX Packaging Tools" / ` +
      `"Windows SDK Signing Tools" components include it).`,
  );
}
console.log(`[${TAG}] makeappx: ${makeappx}`);

const pkgJson = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
);
const version = toPackageVersion(pkgJson.version);
console.log(`[${TAG}] package version ${version} (from ${pkgJson.version})`);

// ── Render the manifest ─────────────────────────────────────────────────────
const templatePath = path.join(
  ROOT,
  "build",
  "msix",
  "AppxManifest.template.xml",
);
if (!fs.existsSync(templatePath))
  fail(`manifest template missing: ${templatePath}`);
const manifest = fs
  .readFileSync(templatePath, "utf8")
  .replaceAll("{{VERSION}}", version);

// An unresolved placeholder produces a package that installs but misbehaves, so
// treat it as fatal rather than shipping it.
const leftover = manifest.match(/\{\{[A-Z_]+\}\}/g);
if (leftover)
  fail(
    `unresolved manifest placeholder(s): ${[...new Set(leftover)].join(", ")}`,
  );
if (!manifest.includes(`Executable="${EXECUTABLE}"`)) {
  fail(
    `manifest does not declare Executable="${EXECUTABLE}" — check the template`,
  );
}

// ── Stage the package layout ────────────────────────────────────────────────
const layoutDir = path.join(ROOT, "out", "msix", `layout-${arch}`);
fs.rmSync(layoutDir, { recursive: true, force: true });
fs.mkdirSync(layoutDir, { recursive: true });
fs.cpSync(packageDir, layoutDir, { recursive: true });

const assetsSrc = path.join(ROOT, "build", "msix", "assets");
if (!fs.existsSync(assetsSrc)) {
  fail(
    `MSIX assets missing: ${assetsSrc} — run \`node scripts/gen-icons.mjs\` on macOS`,
  );
}
fs.cpSync(assetsSrc, path.join(layoutDir, "Assets"), { recursive: true });
fs.writeFileSync(path.join(layoutDir, "AppxManifest.xml"), manifest);
console.log(`[${TAG}] staged layout: ${path.relative(ROOT, layoutDir)}`);

// ── Pack ────────────────────────────────────────────────────────────────────
const outDir = path.join(ROOT, "out", "msix");
const msixName = `${APP}-${pkgJson.version}-${arch}.msix`;
const msixPath = path.join(outDir, msixName);
fs.rmSync(msixPath, { force: true });

try {
  execFileSync(makeappx, ["pack", "/d", layoutDir, "/p", msixPath, "/o"], {
    stdio: "inherit",
  });
} catch (err) {
  fail(`makeappx pack failed: ${err.message}`);
}
if (!fs.existsSync(msixPath))
  fail(`makeappx reported success but ${msixPath} is missing`);

const sizeMiB = (fs.statSync(msixPath).size / 1024 / 1024).toFixed(1);
console.log(
  `[${TAG}] built ${path.relative(ROOT, msixPath)} (${sizeMiB} MiB) — UNSIGNED`,
);

if (upload) {
  const uploadPath = path.join(
    outDir,
    `${APP}-${pkgJson.version}-${arch}.msixupload`,
  );
  writeStoredZip(uploadPath, [
    { name: msixName, data: fs.readFileSync(msixPath) },
  ]);
  console.log(`[${TAG}] wrapped ${path.relative(ROOT, uploadPath)}`);
}

console.log(
  `[${TAG}] next: sign it on a Windows machine before installing — see docs/MSIX_RUNBOOK.md`,
);
