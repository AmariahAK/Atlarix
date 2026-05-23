#!/usr/bin/env node
/**
 * Fetch or copy Universal Ctags binary into assets/ctags/{platform}/.
 *
 * macOS: Homebrew copy, then ctags-nightly-build download.
 * Linux: ctags-nightly-build static build.
 * Windows: universal-ctags/ctags-win32 release zip.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

/** Pin nightly snapshot (Universal Ctags 6.x). Updated periodically. */
const CTAGS_NIGHTLY_TAG = "2026.05.14+173707379ee89beaea30896652bd23931cb2f08d";
const CTAGS_WIN32_API = "https://api.github.com/repos/universal-ctags/ctags-win32/releases";
const NIGHTLY_API = "https://api.github.com/repos/universal-ctags/ctags-nightly-build/releases/tags/";

function platformKey() {
  const p = process.platform;
  const a = process.arch;
  if (p === "darwin") return a === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (p === "win32") return "win32-x64";
  return a === "arm64" ? "linux-arm64" : "linux-x64";
}

function destDir() {
  return path.join(ROOT, "assets", "ctags", platformKey());
}

function exeName() {
  return process.platform === "win32" ? "ctags.exe" : "ctags";
}

function isUniversalCtags(bin) {
  try {
    const out = execSync(`"${bin}" --version`, { encoding: "utf-8" });
    return /Universal Ctags/i.test(out);
  } catch {
    return false;
  }
}

function verifyJsonOutput(bin) {
  try {
    const out = execSync(`"${bin}" --help`, { encoding: "utf-8" });
    return /--output-format=[^)\n]*\bjson\b/i.test(out);
  } catch {
    return false;
  }
}

async function downloadToFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  if (!res.body) throw new Error(`Empty body: ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

function isWin64ZipAsset(name) {
  return (
    /^ctags-.*-x64\.zip$/i.test(name) &&
    !name.includes("debug") &&
    !name.includes("clang")
  );
}

/** Resolve ctags-win32 x64 zip (asset names: ctags-{version}-x64.zip, not -win-x64). */
async function resolveWin32AssetUrl() {
  const res = await fetch(`${CTAGS_WIN32_API}?per_page=20`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "atlarix-fetch-ctags" },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ctags-win32 releases`);
  const releases = await res.json();
  if (!Array.isArray(releases) || releases.length === 0) {
    throw new Error("No ctags-win32 releases found");
  }

  const commitPrefix = CTAGS_NIGHTLY_TAG.split("+")[1]?.slice(0, 7);
  const datePart = CTAGS_NIGHTLY_TAG.split("+")[0]?.replace(/\./g, "-");

  const pickAsset = (rel) =>
    rel.assets?.find((a) => isWin64ZipAsset(a.name));

  // Prefer a win32 build aligned with the pinned nightly commit/date.
  for (const rel of releases) {
    const tag = String(rel.tag_name ?? "");
    const matchesPinned =
      (commitPrefix && tag.includes(commitPrefix)) ||
      (datePart && tag.includes(datePart));
    if (!matchesPinned) continue;
    const asset = pickAsset(rel);
    if (asset) return asset.browser_download_url;
  }

  for (const rel of releases) {
    const asset = pickAsset(rel);
    if (asset) return asset.browser_download_url;
  }

  throw new Error("No ctags-win32 x64 zip asset found in recent releases");
}

function copyFromMacHomebrew() {
  const candidates = ["/opt/homebrew/bin/ctags", "/usr/local/bin/ctags"];
  for (const src of candidates) {
    if (!fs.existsSync(src) || !isUniversalCtags(src)) continue;
    const dest = path.join(destDir(), exeName());
    fs.mkdirSync(destDir(), { recursive: true });
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, 0o755);
    console.log(`Copied Universal Ctags from ${src} → ${dest}`);
    return true;
  }
  return false;
}

function copyFromKnownPaths() {
  const candidates = [
    "/opt/homebrew/bin/ctags",
    "/usr/local/bin/ctags",
  ];
  for (const src of candidates) {
    if (!fs.existsSync(src) || !isUniversalCtags(src)) continue;
    const dest = path.join(destDir(), exeName());
    fs.mkdirSync(destDir(), { recursive: true });
    fs.copyFileSync(src, dest);
    if (process.platform !== "win32") fs.chmodSync(dest, 0o755);
    console.log(`Copied Universal Ctags from ${src} → ${dest}`);
    return true;
  }
  return false;
}

async function extractTarXz(archivePath, destDirPath, innerBinPath) {
  const tmpDir = path.join(destDirPath, ".extract-tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  execSync(`tar -xJf "${archivePath}" -C "${tmpDir}"`, { stdio: "inherit" });
  const extracted = path.join(tmpDir, innerBinPath);
  if (!fs.existsSync(extracted)) {
    const found = execSync(`find "${tmpDir}" -name ctags -type f 2>/dev/null | head -1`, {
      encoding: "utf-8",
    }).trim();
    if (!found) throw new Error(`ctags binary not found in ${archivePath}`);
    return found;
  }
  return extracted;
}

function nightlyDownloadUrl(assetFile) {
  return `${NIGHTLY_API.replace("/releases/tags/", "/releases/download/")}${encodeURIComponent(CTAGS_NIGHTLY_TAG)}/${assetFile}`;
}

async function fetchNightlyTar(assetFile, innerBinPath) {
  const dest = path.join(destDir(), exeName());
  const archive = path.join(destDir(), assetFile);
  fs.mkdirSync(destDir(), { recursive: true });
  const url = `https://github.com/universal-ctags/ctags-nightly-build/releases/download/${encodeURIComponent(CTAGS_NIGHTLY_TAG)}/${assetFile}`;
  console.log(`Downloading ${url}`);
  await downloadToFile(url, archive);
  const extracted = await extractTarXz(archive, destDir(), innerBinPath);
  fs.copyFileSync(extracted, dest);
  fs.chmodSync(dest, 0o755);
  fs.rmSync(path.join(destDir(), ".extract-tmp"), { recursive: true, force: true });
  try {
    fs.unlinkSync(archive);
  } catch {
    /* ignore */
  }
  console.log(`Installed ${dest}`);
}

async function fetchLinux() {
  const key = platformKey();
  const arch = key === "linux-arm64" ? "aarch64" : "x86_64";
  const datePart = CTAGS_NIGHTLY_TAG.split("+")[0];
  const assetFile = `uctags-${datePart}-linux-${arch}.release.tar.xz`;
  const assetBase = assetFile.replace(".tar.xz", "");
  await fetchNightlyTar(assetFile, `${assetBase}/bin/ctags`);
}

async function fetchDarwin() {
  const key = platformKey();
  const arch = key === "darwin-arm64" ? "arm64" : "x86_64";
  const datePart = CTAGS_NIGHTLY_TAG.split("+")[0];
  const macOs = arch === "arm64" ? "15.0" : "15.0";
  const assetFile = `uctags-${datePart}-macos-${macOs}-${arch}.release.tar.xz`;
  const assetBase = assetFile.replace(".tar.xz", "");
  await fetchNightlyTar(assetFile, `${assetBase}/bin/ctags`);
}

async function fetchWindows() {
  const url = await resolveWin32AssetUrl();
  const dest = path.join(destDir(), exeName());
  const zipPath = path.join(destDir(), "ctags-win.zip");
  fs.mkdirSync(destDir(), { recursive: true });
  console.log(`Downloading ${url}`);
  await downloadToFile(url, zipPath);
  execSync(
    `powershell -NoProfile -Command "Expand-Archive -Force -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir().replace(/'/g, "''")}'"`,
    { stdio: "inherit" },
  );
  const candidates = [
    path.join(destDir(), "ctags.exe"),
    path.join(destDir(), "ctags", "ctags.exe"),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    const listed = execSync(`powershell -NoProfile -Command "Get-ChildItem -Recurse -Filter ctags.exe '${destDir()}' | Select-Object -First 1 -ExpandProperty FullName"`, {
      encoding: "utf-8",
    }).trim();
    if (!listed) throw new Error("ctags.exe not found in zip");
    fs.copyFileSync(listed, dest);
  } else if (found !== dest) {
    fs.copyFileSync(found, dest);
  }
  try {
    fs.unlinkSync(zipPath);
  } catch {
    /* ignore */
  }
  console.log(`Installed ${dest}`);
}

async function main() {
  const dest = path.join(destDir(), exeName());
  if (fs.existsSync(dest) && isUniversalCtags(dest) && verifyJsonOutput(dest)) {
    console.log(`Already present: ${dest}`);
    return;
  }

  if (copyFromKnownPaths() && verifyJsonOutput(dest)) return;

  if (process.platform === "darwin") {
    if (copyFromMacHomebrew() && verifyJsonOutput(dest)) return;
    try {
      await fetchDarwin();
      if (isUniversalCtags(dest) && verifyJsonOutput(dest)) return;
    } catch (err) {
      console.warn("macOS download failed:", err instanceof Error ? err.message : err);
    }
  }

  if (process.platform === "linux") {
    try {
      await fetchLinux();
      if (isUniversalCtags(dest) && verifyJsonOutput(dest)) return;
    } catch (err) {
      console.warn("Linux download failed:", err instanceof Error ? err.message : err);
    }
  }

  if (process.platform === "win32") {
    try {
      await fetchWindows();
      if (isUniversalCtags(dest) && verifyJsonOutput(dest)) return;
    } catch (err) {
      console.warn("Windows download failed:", err instanceof Error ? err.message : err);
    }
  }

  console.error(
    `Could not install Universal Ctags for ${platformKey()}.\n` +
      `  brew install universal-ctags   OR   npm run fetch-ctags\n` +
      `  Manual path: ${dest}`,
  );
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  setImmediate(() => process.exit(1));
});
