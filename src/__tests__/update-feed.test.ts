/**
 * The electron-updater feeds a release publishes (scripts/update-feed.mjs),
 * read back by electron-updater's own code.
 *
 * Intel Macs never updated (15.11.0 artifact check): the arm64 job alone wrote
 * latest-mac.yml, and electron-updater on an Intel Mac drops every file whose
 * name contains "arm64", leaving nothing. deb/rpm need their own files in
 * latest-linux.yml, picked by extension.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ResolvedUpdateFileInfo } from "electron-updater";
import { MacUpdater } from "electron-updater/out/MacUpdater";
import {
  findFile,
  parseUpdateInfo,
  resolveFiles,
} from "electron-updater/out/providers/Provider";
// Typed by its sibling scripts/update-feed.d.mts.
import { feedFile, linuxFeed, macFeed } from "../../scripts/update-feed.mjs";

const BASE = new URL(
  "https://github.com/AmariahAK/atlarix-releases/releases/download/v15.11.1/",
);

function written(names: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-"));
  return names.map((n) => {
    fs.writeFileSync(path.join(dir, n), `bytes of ${n}`);
    return feedFile(path.join(dir, n));
  });
}

/** The feed as electron-updater reads it: parsed and resolved by its own provider code. */
function read(yaml: string, channel: string) {
  const info = parseUpdateInfo(yaml, channel, new URL(channel, BASE));
  return { info, files: resolveFiles(info, BASE) };
}

// Protected in the typings; it is the filter MacUpdater runs before downloading.
const filterFilesForArch = (
  MacUpdater as unknown as {
    filterFilesForArch(
      files: ResolvedUpdateFileInfo[],
      isArm64Mac: boolean,
    ): ResolvedUpdateFileInfo[];
  }
).filterFilesForArch;

const zipFor = (files: ResolvedUpdateFileInfo[], arm64Mac: boolean) =>
  filterFilesForArch(files, arm64Mac)
    .filter((f) => f.url.pathname.endsWith(".zip"))
    .map((f) => f.info.url);

const MAC = [
  "Atlarix-darwin-arm64-15.11.1.zip",
  "Atlarix-15.11.1-arm64.dmg",
  "Atlarix-darwin-x64-15.11.1.zip",
  "Atlarix-15.11.1-x64.dmg",
];

describe("latest-mac.yml", () => {
  it("gives an Intel Mac the x64 zip and an Apple silicon Mac the arm64 zip", () => {
    const { info, files } = read(
      macFeed("15.11.1", written(MAC)),
      "latest-mac.yml",
    );
    expect(zipFor(files, false)).toEqual(["Atlarix-darwin-x64-15.11.1.zip"]);
    expect(zipFor(files, true)).toEqual(["Atlarix-darwin-arm64-15.11.1.zip"]);
    // Older clients read the top-level path: still the arm64 zip, as before.
    expect(info.path).toBe("Atlarix-darwin-arm64-15.11.1.zip");
  });

  it("refuses a feed missing an arch: that is the bug", () => {
    expect(() => macFeed("15.11.1", written([MAC[0], MAC[1]]))).toThrow(
      /x64 \.zip/,
    );
  });

  it("the old arm64-only feed left an Intel Mac nothing (why the above matters)", () => {
    const [arm, dmg] = written([MAC[0], MAC[1]]);
    const old = `version: 15.11.0\nfiles:\n${[arm, dmg]
      .map(
        (f) =>
          `  - url: ${f.url}\n    sha512: ${f.sha512}\n    size: ${f.size}\n`,
      )
      .join(
        "",
      )}path: ${arm.url}\nsha512: ${arm.sha512}\nreleaseDate: '2026-10-23T22:15:39.000Z'\n`;
    expect(zipFor(read(old, "latest-mac.yml").files, false)).toEqual([]);
  });

  it("each entry carries the file's sha512 (base64) and size", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-"));
    const file = path.join(dir, "a.zip");
    fs.writeFileSync(file, "hello");
    expect(feedFile(file)).toEqual({
      url: "a.zip",
      sha512:
        "m3HSJL1i83hdltRq0+o9czGb+8KJDKra4t/3JRlnPKcjI8PZm6XBHXx6zG4UuMXaDEZjR1wuXDre9G9zvN7AQw==",
      size: 5,
    });
  });
});

describe("latest-linux.yml", () => {
  const LINUX = [
    "Atlarix-15.11.1-x64.AppImage",
    "atlarix_15.11.1_amd64.deb",
    "atlarix-15.11.1-1.x86_64.rpm",
  ];

  it("lists the AppImage, deb and rpm, and each updater finds its own", () => {
    const { info, files } = read(
      linuxFeed("15.11.1", written(LINUX)),
      "latest-linux.yml",
    );
    // The lookups DebUpdater, RpmUpdater and AppImageUpdater make.
    expect(
      findFile(files, "deb", ["AppImage", "rpm", "pacman"])?.info.url,
    ).toBe(LINUX[1]);
    expect(
      findFile(files, "rpm", ["AppImage", "deb", "pacman"])?.info.url,
    ).toBe(LINUX[2]);
    expect(
      findFile(files, "AppImage", ["rpm", "deb", "pacman"])?.info.url,
    ).toBe(LINUX[0]);
    // Older AppImage clients read the top-level path.
    expect(info.path).toBe(LINUX[0]);
  });

  it("refuses a release without the deb or rpm", () => {
    expect(() => linuxFeed("15.11.1", written([LINUX[0], LINUX[1]]))).toThrow(
      /\.rpm/,
    );
  });
});
