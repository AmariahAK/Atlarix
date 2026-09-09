/**
 * The sandbox's default writable set used ONE curated cache list for all three
 * platforms, and it was POSIX-shaped. Two consequences, both real:
 *
 *  1. `~/Library/Caches` and `~/Library/pnpm` are macOS paths, but they sat in the
 *     shared list — and `createMissingCaches` is on for every non-darwin platform
 *     (`process.platform !== "darwin"`), so Linux and Windows machines had those
 *     macOS-shaped directories CREATED in the user's home for nothing.
 *
 *  2. The genuine Windows cache locations were absent entirely. npm on Windows
 *     caches to `%LOCALAPPDATA%\npm-cache`, not `~/.npm`, and sets no
 *     `npm_config_cache` for the env-var layer to pick up. Under Low IL an
 *     unlabelled directory is simply unwritable, so agent-run `npm install` could
 *     not write its cache.
 *
 * These assert the LISTS rather than driving `wrapCommandInSandbox`, deliberately.
 * The existing sandbox tests are gated with `describe.runIf(isMac)`, and CI's
 * `quality` job runs on ubuntu — so a Windows-gated test would execute on no
 * machine at all. That is exactly how the AppContainer helper shipped broken.
 * These run everywhere.
 */
import { describe, expect, it, afterEach } from "vitest";
import path from "node:path";
import {
  HOME_CACHE_DIRS,
  MACOS_CACHE_DIRS,
  dockerBuildxDirs,
  windowsCacheDirs,
} from "@/lib/sandbox/wrap-command";

const flatten = (dirs: readonly (readonly string[])[]) =>
  dirs.map((segments) => segments.join("/"));

describe("cross-platform home cache dirs", () => {
  it("contains no macOS-only Library path", () => {
    // The regression: `Library/*` in the shared list got created on Linux/Windows.
    for (const entry of HOME_CACHE_DIRS) {
      expect(entry[0]).not.toBe("Library");
    }
  });

  it("keeps the toolchains that really do use ~/.<name> on Windows too", () => {
    const flat = flatten(HOME_CACHE_DIRS);
    // cargo, rustup, gradle, maven and GOPATH all default under %USERPROFILE% on
    // Windows, and Git bash makes ~/.cache and ~/.config real there as well.
    for (const expected of [
      ".cargo",
      ".rustup",
      ".gradle",
      ".m2",
      "go/pkg",
      ".cache",
    ]) {
      expect(flat).toContain(expected);
    }
  });

  it("covers NuGet, which uses ~/.nuget/packages on every platform", () => {
    expect(flatten(HOME_CACHE_DIRS)).toContain(".nuget/packages");
  });

  it("grants ~/.docker/buildx, without which no Docker build runs at all", () => {
    // Docker Desktop's buildx writes an activity timestamp under
    // `~/.docker/buildx/activity/` on EVERY build and ABORTS if it cannot. Observed
    // 2026-08-29: `docker compose build` failed with an unattributable
    // "operation not permitted" and cost an agent six turns chasing xattrs.
    expect(flatten(HOME_CACHE_DIRS)).toContain(".docker/buildx");
  });

  it("does NOT grant ~/.docker itself — config.json holds registry credentials", () => {
    // The narrow path is the whole point. Widening this entry to the parent to
    // "simplify" would turn the sandbox into a credential-tamper surface, so fail
    // loudly if anyone does.
    expect(flatten(HOME_CACHE_DIRS)).not.toContain(".docker");
    for (const entry of HOME_CACHE_DIRS) {
      if (entry[0] === ".docker") expect(entry.length).toBeGreaterThan(1);
    }
  });
});

describe("dockerBuildxDirs", () => {
  const saved = process.env.DOCKER_CONFIG;
  afterEach(() => {
    if (saved === undefined) delete process.env.DOCKER_CONFIG;
    else process.env.DOCKER_CONFIG = saved;
  });

  it("follows a redirected DOCKER_CONFIG, which the curated ~/.docker entry misses", () => {
    // buildx resolves its default as `$DOCKER_CONFIG/buildx`. Neither other layer
    // covers this: the env layer only sees BUILDX_CONFIG (usually unset), and the
    // curated entry is the wrong path once DOCKER_CONFIG moves.
    process.env.DOCKER_CONFIG = "/custom/docker";
    expect(dockerBuildxDirs()).toEqual([path.join("/custom/docker", "buildx")]);
  });

  it("stays empty when DOCKER_CONFIG is unset — the curated entry already covers it", () => {
    delete process.env.DOCKER_CONFIG;
    expect(dockerBuildxDirs()).toEqual([]);
  });

  it("never yields the config dir itself", () => {
    process.env.DOCKER_CONFIG = "/custom/docker";
    expect(dockerBuildxDirs()).not.toContain("/custom/docker");
  });
});

describe("macOS-only cache dirs", () => {
  it("holds exactly the two Library paths, so they can be darwin-gated", () => {
    expect(flatten(MACOS_CACHE_DIRS)).toEqual([
      "Library/Caches",
      "Library/pnpm",
    ]);
  });
});

describe("windowsCacheDirs", () => {
  const savedLocal = process.env.LOCALAPPDATA;
  const savedRoaming = process.env.APPDATA;

  afterEach(() => {
    if (savedLocal === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = savedLocal;
    if (savedRoaming === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = savedRoaming;
  });

  it("grants npm's real Windows cache, which ~/.npm does not cover", () => {
    process.env.LOCALAPPDATA = "C:\\Users\\t\\AppData\\Local";
    delete process.env.APPDATA;
    expect(windowsCacheDirs()).toContain(
      path.join("C:\\Users\\t\\AppData\\Local", "npm-cache"),
    );
  });

  it("grants the other off-$HOME Windows toolchain caches", () => {
    const local = "C:\\Users\\t\\AppData\\Local";
    process.env.LOCALAPPDATA = local;
    const dirs = windowsCacheDirs();
    for (const tail of [
      "pnpm",
      path.join("Yarn", "Cache"),
      "go-build",
      "deno",
    ]) {
      expect(dirs).toContain(path.join(local, tail));
    }
  });

  it("grants the roaming npm prefix from APPDATA", () => {
    delete process.env.LOCALAPPDATA;
    process.env.APPDATA = "C:\\Users\\t\\AppData\\Roaming";
    expect(windowsCacheDirs()).toEqual([
      path.join("C:\\Users\\t\\AppData\\Roaming", "npm"),
    ]);
  });

  it("follows a REDIRECTED AppData rather than composing one from the home dir", () => {
    // Folder Redirection / roaming profiles move AppData off the profile entirely.
    // Reading the env var is what makes this correct instead of guessed.
    process.env.LOCALAPPDATA = "\\\\fileserver\\redirected\\t\\Local";
    delete process.env.APPDATA;
    for (const dir of windowsCacheDirs()) {
      expect(dir.startsWith("\\\\fileserver\\redirected\\t\\Local")).toBe(true);
    }
  });

  it("returns nothing when neither variable is set, rather than a bogus path", () => {
    delete process.env.LOCALAPPDATA;
    delete process.env.APPDATA;
    expect(windowsCacheDirs()).toEqual([]);
  });
});
