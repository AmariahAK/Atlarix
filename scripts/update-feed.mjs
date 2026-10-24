#!/usr/bin/env node
/**
 * electron-updater feeds (latest-mac.yml, latest-linux.yml) for a release.
 *
 *   node scripts/update-feed.mjs fragment --out mac-arm64.json <zip> <dmg>
 *   node scripts/update-feed.mjs mac --version 15.11.1 --out latest-mac.yml <fragment.json>...
 *   node scripts/update-feed.mjs linux --version 15.11.1 --out latest-linux.yml <AppImage> <deb> <rpm>
 *
 * The Mac feed lists BOTH arches. electron-updater on an Intel Mac drops every
 * file whose name contains "arm64" (MacUpdater.filterFilesForArch), so a feed
 * written by the arm64 job alone left Intel installs with nothing to download:
 * they never updated (15.11.0 artifact check). The arm64 and x64 jobs each
 * write a fragment; one job joins them, and refuses when an arch is missing.
 *
 * The Linux feed lists the AppImage, .deb and .rpm: DebUpdater and RpmUpdater
 * pick their file by extension. The top-level `path` stays the AppImage, which
 * is what older AppImage clients read.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { argValue } from "./cli-args.mjs";

/** One `files:` entry: name, sha512 (base64) and size, as electron-updater checks them. */
export function feedFile(file) {
  const data = fs.readFileSync(file);
  return {
    url: path.basename(file),
    sha512: crypto.createHash("sha512").update(data).digest("base64"),
    size: data.length,
  };
}

export function feedYaml({
  version,
  files,
  primary,
  releaseDate = new Date().toISOString(),
}) {
  const lines = [`version: ${version}`, "files:"];
  for (const f of files)
    lines.push(
      `  - url: ${f.url}`,
      `    sha512: ${f.sha512}`,
      `    size: ${f.size}`,
    );
  lines.push(
    `path: ${primary.url}`,
    `sha512: ${primary.sha512}`,
    `releaseDate: '${releaseDate}'`,
  );
  return lines.join("\n") + "\n";
}

function pick(files, test, what) {
  const hit = files.find((f) => test(f.url));
  if (!hit)
    throw new Error(
      `update feed: no ${what} among ${files.map((f) => f.url).join(", ") || "(nothing)"}`,
    );
  return hit;
}

/** Both arches' zips first (arm64 is `path`, as before), then the DMGs. */
export function macFeed(version, files, releaseDate) {
  const arm = pick(
    files,
    (u) => u.endsWith(".zip") && u.includes("arm64"),
    "arm64 .zip",
  );
  const x64 = pick(
    files,
    (u) => u.endsWith(".zip") && u.includes("x64"),
    "x64 .zip",
  );
  const dmgs = files.filter((f) => f.url.endsWith(".dmg"));
  return feedYaml({
    version,
    files: [arm, x64, ...dmgs],
    primary: arm,
    releaseDate,
  });
}

export function linuxFeed(version, files, releaseDate) {
  const appImage = pick(files, (u) => u.endsWith(".AppImage"), ".AppImage");
  const deb = pick(files, (u) => u.endsWith(".deb"), ".deb");
  const rpm = pick(files, (u) => u.endsWith(".rpm"), ".rpm");
  return feedYaml({
    version,
    files: [appImage, deb, rpm],
    primary: appImage,
    releaseDate,
  });
}

function main(argv) {
  const [mode, ...rest] = argv;
  const out = argValue(rest, "out");
  const version = argValue(rest, "version");
  const inputs = rest.filter(
    (a, i) => !a.startsWith("--") && !rest[i - 1]?.startsWith("--"),
  );
  if (!out) throw new Error("update feed: --out is required");
  if (mode === "fragment") {
    fs.writeFileSync(out, JSON.stringify(inputs.map(feedFile), null, 2));
  } else if (mode === "mac" || mode === "linux") {
    if (!version) throw new Error("update feed: --version is required");
    const files =
      mode === "mac"
        ? inputs.flatMap((f) => JSON.parse(fs.readFileSync(f, "utf8")))
        : inputs.map(feedFile);
    fs.writeFileSync(
      out,
      mode === "mac" ? macFeed(version, files) : linuxFeed(version, files),
    );
  } else {
    throw new Error(
      `update feed: unknown mode "${mode}" (fragment | mac | linux)`,
    );
  }
  console.log(fs.readFileSync(out, "utf8"));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(
      `::error::${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}
