import type { ForgeConfig } from "@electron-forge/shared-types";
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerZIP } from "@electron-forge/maker-zip";
import { MakerAppImage } from "@reforged/maker-appimage";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { rebuild } from "@electron/rebuild";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

/**
 * Runs `npm install` inside the PRUNED app tree, which has consequences that are easy to
 * miss: the staged `package.json` comes with us, so **the app's own `postinstall` runs
 * here**, in a tree installed with `--omit=dev` and therefore WITHOUT devDependencies.
 *
 * That is why `postinstall`'s trailing `|| true` is load-bearing and must stay last:
 * `patch-package` is a devDependency, so its binary does not exist in this tree. On
 * Windows that surfaces as
 *
 *     'patch-package' is not recognized as an internal or external command
 *
 * and the `&&` chain fails. `(patch-package && …) || true` swallows it; moving the
 * parenthesis to `patch-package && (… || true)` does NOT, and packaging dies here with
 * "npm install exited with code 1". Linux and macOS resolve the binary and never notice
 * the difference, so this only breaks Windows — and only at package time. It cost the
 * first v14.30.0 tag.
 *
 * The guard that patch-package actually applied lives where it can be enforced: CI runs
 * `npx patch-package` as its own step, and each remaining patch has a test that asserts
 * its bytes are present in the installed tree (`node-gyp-vs2026-patch.test.ts`,
 * `scripts/verify-forge-patch.mjs`). The third patch, on `transformers.web.js`, went with
 * the on-device speech engine.
 */
function runNpmInstall(cwd: string, args: string[]): Promise<void> {
  const useShell = process.platform === "win32";
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(npm, args, {
      cwd,
      stdio: "inherit",
      shell: useShell,
      env: process.env,
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm install exited with code ${code}`));
    });
    proc.on("error", reject);
  });
}

function npmTargetPlatformArgs(platform: string, arch: string): string[] {
  return [`--os=${platform}`, `--cpu=${arch}`];
}

/** Rollup `external` may use subpaths (`tiktoken/lite`, `pdfjs-dist/build/foo`); `npm install` needs the package root. */
function rollupExternalIdToNpmPackageRoot(id: string): string {
  if (!id || id.startsWith("node:")) return id;
  if (id.startsWith("@")) {
    const parts = id.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : id;
  }
  const slash = id.indexOf("/");
  return slash === -1 ? id : id.slice(0, slash);
}

/** Do not `npm install` into the pruned build — packager `ignore` runs earlier; these must be filtered here. */
const RENDERER_ONLY_PACKAGES = new Set([
  "lucide-react",
  "date-fns",
  "posthog-js",
  "posthog-node",
  "react-shiki",
  "shiki",
  "@shikijs",
  "core-js",
  "@tanstack",
  "echarts",
  "zrender",
]);

/**
 * Linux icon theme map for the deb/rpm makers.
 *
 * `electron-installer-common` branches on the shape of `options.icon`: an OBJECT
 * installs into `/usr/share/icons/hicolor/<key>/apps/` (a proper multi-resolution
 * theme entry), a STRING installs a single pixmap, and OMITTING it falls back to
 * the module's own bundled default — which is the generic Electron atom. deb/rpm
 * previously set no icon at all, so both shipped the Electron logo.
 *
 * Keys must be the hicolor resolution directory names, so they are stated
 * explicitly rather than derived from the iconset's macOS `@2x` filenames (where
 * `icon_32x32@2x.png` is in fact 64x64). All files are regenerated from
 * `assets/icon/logo.icns` by `scripts/gen-icons.mjs`.
 */
const LINUX_HICOLOR_ICONS = {
  "16x16": "./assets/icon/logo.iconset/icon_16x16.png",
  "32x32": "./assets/icon/logo.iconset/icon_32x32.png",
  "64x64": "./assets/icon/logo.iconset/icon_32x32@2x.png",
  "128x128": "./assets/icon/logo.iconset/icon_128x128.png",
  "256x256": "./assets/icon/logo.iconset/icon_256x256.png",
  "512x512": "./assets/icon/logo.iconset/icon_512x512.png",
};

/** Dev/test packages that must never ship in production asar. */
const RELEASE_DENY_PACKAGES = [
  "playwright",
  "playwright-core",
  "electron-playwright-helpers",
  "typescript",
  "eslint",
  "vitest",
  "happy-dom",
  "drizzle-kit",
  "esbuild",
  "vite",
] as const;

// Based on https://github.com/electron/forge/blob/6b2d547a7216c30fde1e1fddd1118eee5d872945/packages/plugin/vite/src/VitePlugin.ts#L124
const ignore = (file: string) => {
  if (!file) return false;
  // `file` always starts with `/`
  // @see - https://github.com/electron/packager/blob/v18.1.3/src/copy-filter.ts#L89-L93
  // Never copy build output or local caches (packager tmpdir may live under .cache on CI).
  if (file === "/.cache" || file.startsWith("/.cache/")) {
    return true;
  }
  if (file === "/out" || file.startsWith("/out/")) {
    return true;
  }
  // Required for validateElectronApp; Vite plugin also writes this in packageAfterCopy.
  if (file === "/package.json") {
    return false;
  }
  if (file === "/node_modules") {
    return false;
  }
  // drizzle/*.sql is bundled into the main process via Vite ?raw — omit from asar to shrink the package.
  if (file.startsWith("/drizzle")) {
    return true;
  }
  if (file.endsWith(".map")) {
    return true;
  }

  if (file.startsWith("/worker") && !file.startsWith("/workers")) {
    return false;
  }
  if (file.startsWith("/node_modules/stacktrace-js")) {
    return false;
  }
  if (file.startsWith("/node_modules/stacktrace-js/dist")) {
    return false;
  }
  if (file.startsWith("/node_modules/html-to-image")) {
    return false;
  }
  if (file.startsWith("/node_modules/better-sqlite3")) {
    return false;
  }
  if (file.startsWith("/node_modules/web-tree-sitter")) {
    return false;
  }
  if (file.startsWith("/node_modules/tree-sitter-wasms")) {
    return false;
  }
  // tiktoken ships tiktoken_bg.wasm next to lite/*.cjs — must stay unpackaged from Rollup with real __dirname (see vite.main.config external).
  if (file.startsWith("/node_modules/tiktoken")) {
    return false;
  }
  if (file.startsWith("/node_modules/unpdf")) {
    return false;
  }
  if (file.startsWith("/node_modules/@anthropic-ai/tokenizer")) {
    return false;
  }
  // Force-exclude loose copies from asar (bundled into .vite renderer output or unused in main).
  if (file.startsWith("/node_modules/lucide-react")) return true;
  if (file.startsWith("/node_modules/date-fns")) return true;
  if (file.startsWith("/node_modules/posthog-js")) return true;
  if (file.startsWith("/node_modules/react-shiki")) return true;
  if (file.startsWith("/node_modules/@shikijs")) return true;
  if (file.startsWith("/node_modules/shiki")) return true;
  if (file.startsWith("/node_modules/core-js")) return true;
  if (file.startsWith("/node_modules/@tanstack")) return true;
  if (file.startsWith("/node_modules/echarts")) return true;
  if (file.startsWith("/node_modules/zrender")) return true;
  // v11: geist/next/dugite are no longer dependencies (fonts vendored in
  // src/assets/fonts; system git via system_git_exec). Keep ignoring them so
  // stale node_modules from older checkouts can never leak into a package.
  if (file.startsWith("/node_modules/geist")) return true;
  if (file.startsWith("/node_modules/next")) return true;
  if (file.startsWith("/node_modules/@next")) return true;
  if (file.startsWith("/node_modules/dugite")) return true;
  for (const deny of RELEASE_DENY_PACKAGES) {
    if (
      file === `/node_modules/${deny}` ||
      file.startsWith(`/node_modules/${deny}/`)
    ) {
      return true;
    }
  }
  if (file.startsWith("/node_modules/@playwright/")) return true;
  if (file.startsWith("/node_modules/@vitest/")) return true;
  if (file.startsWith("/node_modules/bindings")) {
    return false;
  }
  if (file.startsWith("/node_modules/file-uri-to-path")) {
    return false;
  }
  if (file.startsWith("/.vite")) {
    return false;
  }

  return true;
};

async function stripSourceMapsFromBuild(buildPath: string): Promise<number> {
  const fs = await import("node:fs/promises");
  let removed = 0;
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile() && e.name.endsWith(".map")) {
        await fs.rm(full, { force: true });
        removed++;
      }
    }
  }
  // The bundle's maps exist only for a release's Sentry upload (ATLARIX_SOURCEMAPS)
  // and never ship; `npm install` also drops ~10k+ `.map` files under node_modules.
  await walk(path.join(buildPath, ".vite", "build"));
  await walk(path.join(buildPath, ".vite", "renderer"));
  const nm = path.join(buildPath, "node_modules");
  try {
    await fs.access(nm);
    await walk(nm);
  } catch {
    /* no node_modules yet */
  }
  if (removed > 0) {
    console.log(`[packageAfterPrune] removed ${removed} .map file(s)`);
  }
  return removed;
}

const config: ForgeConfig = {
  packagerConfig: {
    // A12/M-5: keep the Chromium OS sandbox ENABLED (was `false`). It shrinks the
    // blast radius of a renderer compromise and pairs with the CSP (A13) and the
    // main-frame navigation lockdown (A4). NOTE: must be smoke-tested on Linux —
    // if a specific environment needs it off, scope that exception rather than
    // disabling globally. Trivially reverted to `false` if it blocks launch.
    // Electron Packager supports this flag even though Forge's type lags behind.
    // @ts-expect-error chromiumSandbox is forwarded to electron-packager
    chromiumSandbox: true,
    protocols: [
      {
        name: "Atlarix",
        schemes: ["atlarix"],
      },
    ],
    /** App icon basename; Packager resolves `.icns` / `.ico` / `.png` per platform from `assets/icon/logo.*`. */
    icon: "./assets/icon/logo",
    executableName: "atlarix", // Fixes Linux 'could not find binary' error (case sensitivity)

    // osxSign must not be set on win32/linux — packager may invoke codesign and fail silently when quiet:true.
    osxSign:
      process.platform !== "darwin"
        ? undefined
        : {
            identity: "Developer ID Application: Amariah Kamau (7VWW7N9R87)",
            // ONE entitlements file for every path, which is where this started.
            //
            // It briefly split in two so `keychain-access-groups` could reach ONLY
            // the top-level bundle, for the Touch ID authenticator. That
            // entitlement is gone: it is PROVISIONED, so without an embedded
            // provisioning profile the kernel SIGKILLs the binary on exec while
            // `codesign -v` still reports it valid — and it killed the signed
            // v14.35.0 macOS build outright. See docs/DESIGN_NOTES.md.
            //
            // THE LESSON OUTLIVES THE FEATURE, so keep it in view before adding any
            // restricted entitlement here: @electron/osx-sign calls this for every
            // path it signs, nested helpers included (`rg`, `spawn-helper`), and a
            // restricted entitlement on one of those produces a binary that
            // `codesign -v` calls valid and the kernel refuses to exec — no output,
            // no stderr, nothing in the system log.
            //
            // Every nested binary inherits this file, which is safe precisely
            // because it holds nothing provisioned. The plausible additions are
            // traps: `keychain-access-groups` is PROVISIONED (the v14.35.0 killer
            // above) and `com.apple.security.temporary-exception.*` is provisioned
            // and MAS-only. If a bundled helper ever seems to need
            // `disable-library-validation`, treat that as a reason to re-examine
            // the dependency, not to add the entitlement.
            optionsForFile: () => ({
              entitlements: "./entitlements.plist",
              "entitlements-inherit": "./entitlements.plist",
              "hardened-runtime": true,
            }),
          },
    osxNotarize: undefined,
    // electron-packager honors `asar.unpack` (a minimatch glob string), NOT the
    // electron-builder-style top-level `asarUnpack` array (which it silently
    // ignores). AutoUnpackNativesPlugin merges this glob with `**/*.node`.
    // node-pty ships `spawn-helper` (macOS) and conpty/winpty binaries (Windows)
    // as NON-.node siblings of pty.node; without unpacking the platform dir,
    // node-pty resolves the helper to app.asar.unpacked/.../spawn-helper (absent)
    // and the shell dies with "posix_spawnp failed" (can't exec inside an asar).
    asar: {
      unpack:
        "{**/@lydell/node-pty-darwin-*/**,**/@lydell/node-pty-linux-*/**,**/@lydell/node-pty-win32-*/**,**/@vscode/ripgrep-*/bin/**}",
    },
    ignore,
    extraResource: [
      // System-prompt guidance read at runtime by src/prompts/system_prompt.ts via
      // process.resourcesPath. Without this the packaged app falls back to a minimal
      // prompt (root-level files are otherwise excluded by the `ignore` allowlist).
      path.join(__dirname, "AGENTS.md"),
      path.join(__dirname, "src/skills"),
      // electron-updater reads app-update.yml from Contents/Resources/ during the
      // download stage. electron-forge (unlike electron-builder) never generates
      // it, so without this the auto-update download throws an unhandled ENOENT and
      // the banner sticks on "Downloading…" forever. Ship a static copy that
      // matches autoUpdater.setFeedURL(...) in src/main.ts. Copied in before code
      // signing, so it's covered by the bundle signature.
      path.join(__dirname, "build/app-update.yml"),
      // models.dev catalog snapshot — the floor beneath the disk cache in
      // src/lib/models_dev.ts. On a first run with no network there is no cache
      // either, so without this the provider list and model picker come up EMPTY.
      // Committed and regenerated via `npm run models:snapshot` (release runbook),
      // deliberately not fetched at build time so packaging never depends on
      // models.dev being reachable. Guarded: a missing snapshot must not break a
      // build — the app just falls back to the network as it did before.
      ...(fs.existsSync(path.join(__dirname, "build/models-snapshot.json.gz"))
        ? [path.join(__dirname, "build/models-snapshot.json.gz")]
        : []),
      // MCP Registry snapshot — the floor beneath the marketplace's disk cache in
      // src/lib/mcp/registry-catalog.ts, regenerated via `npm run mcp:snapshot`.
      // Guarded the same way: a missing snapshot only means an empty marketplace
      // until the first sync (the Verified servers still show).
      ...(fs.existsSync(path.join(__dirname, "build/mcp-registry-snapshot.json.gz"))
        ? [path.join(__dirname, "build/mcp-registry-snapshot.json.gz")]
        : []),
      // Windows AppContainer sandbox helper (cargo-built + signed in CI before
      // packaging). Resolves at runtime via process.resourcesPath/atlarix-sandbox.exe
      // (see src/lib/sandbox/wrap-command.ts). Guarded so non-Windows / un-built
      // packaging is unaffected.
      ...(process.platform === "win32" &&
      fs.existsSync(
        path.join(
          __dirname,
          "native/atlarix-sandbox/target/release/atlarix-sandbox.exe",
        ),
      )
        ? [
            path.join(
              __dirname,
              "native/atlarix-sandbox/target/release/atlarix-sandbox.exe",
            ),
          ]
        : []),
      // The Chrome native-messaging relay (cargo-built + signed in CI before
      // packaging). Resolves at runtime via
      // process.resourcesPath/atlarix-bridge — see src/main/bridge-lifecycle.ts.
      //
      // SHIPS ON EVERY PLATFORM, unlike the two sandbox helpers above, because
      // the browser bridge is not platform-specific. Guarded so packaging
      // without a build is unaffected: the app then logs that the bridge is
      // unavailable and opens normally.
      ...(fs.existsSync(
        path.join(
          __dirname,
          `native/atlarix-bridge/target/release/atlarix-bridge${process.platform === "win32" ? ".exe" : ""}`,
        ),
      )
        ? [
            path.join(
              __dirname,
              `native/atlarix-bridge/target/release/atlarix-bridge${process.platform === "win32" ? ".exe" : ""}`,
            ),
          ]
        : []),
      // The computer-use executor (screenshots + mouse/keyboard), every
      // platform. Inside the bundle so macOS attributes its Screen Recording
      // and Accessibility grants to Atlarix. Resolves at runtime via
      // process.resourcesPath — see src/lib/computer/helper.ts.
      ...(fs.existsSync(
        path.join(
          __dirname,
          `native/atlarix-computer/target/release/atlarix-computer${process.platform === "win32" ? ".exe" : ""}`,
        ),
      )
        ? [
            path.join(
              __dirname,
              `native/atlarix-computer/target/release/atlarix-computer${process.platform === "win32" ? ".exe" : ""}`,
            ),
          ]
        : []),
      // Linux Landlock sandbox helper (cargo-built in CI; no code-signing needed).
      // Resolves at runtime via process.resourcesPath/atlarix-sandbox-linux
      // (see src/lib/sandbox/wrap-command.ts). Ships on Linux builds natively and
      // on Windows builds for WSL confinement (piped from the build-linux CI job).
      // Guarded so un-built packaging is unaffected; falls back to OS bwrap when absent.
      ...((process.platform === "linux" || process.platform === "win32") &&
      fs.existsSync(
        path.join(
          __dirname,
          "native/atlarix-sandbox-linux/target/release/atlarix-sandbox-linux",
        ),
      )
        ? [
            path.join(
              __dirname,
              "native/atlarix-sandbox-linux/target/release/atlarix-sandbox-linux",
            ),
          ]
        : []),
    ],
  },
  rebuildConfig: {
    extraModules: ["better-sqlite3", "@lydell/node-pty"],
    force: true,
  },
  makers: [
    new MakerSquirrel({
      // The Setup.exe icon. This USED to sit in the `else` arm of a ternary on
      // SM_CODE_SIGNING_CERT_SHA1_HASH — so every signed build (i.e. every real
      // CI release) silently dropped it and shipped Squirrel's default icon.
      // Signing and branding are independent concerns; always set both.
      setupIcon: "./assets/icon/logo.ico",
      iconUrl: "https://www.atlarix.dev/logo.ico",
      ...(process.env.SM_CODE_SIGNING_CERT_SHA1_HASH
        ? {
            signWithParams: `/sha1 ${process.env.SM_CODE_SIGNING_CERT_SHA1_HASH} /tr http://timestamp.digicert.com /td SHA256 /fd SHA256`,
          }
        : {}),
    }),
    new MakerDMG({
      icon: "./assets/icon/logo.icns",
      // appdmg@0.6.6 errors if the target .dmg already exists; allow overwrite so
      // a retried macOS make (see release.yml) doesn't trip on a partial artifact.
      overwrite: true,
    }),
    new MakerZIP({}, ["darwin"]),
    new MakerRpm({
      options: {
        mimeType: ["x-scheme-handler/atlarix"],
        // @ts-expect-error Forge types this as `string`, but the underlying
        // electron-installer-common branches on shape and accepts the hicolor
        // object (see LINUX_HICOLOR_ICONS). The types lag the implementation.
        icon: LINUX_HICOLOR_ICONS,
        // resources/package-type, which makes electron-updater update this
        // install as an rpm. Written on install, not packaged: the deb, rpm and
        // AppImage share one packaged folder, and an AppImage carrying it would
        // try to update itself as a deb.
        scripts: {
          post: path.join(__dirname, "build/linux/rpm-post"),
          postun: path.join(__dirname, "build/linux/rpm-postun"),
        },
        // The computer-use executor's own libraries (its ELF NEEDED list, on
        // top of Electron's defaults), by soname so they resolve on Fedora and
        // openSUSE alike.
        requires: ["libxkbcommon.so.0()(64bit)", "libwayland-client.so.0()(64bit)", "libxcb.so.1()(64bit)"],
      },
    }),
    new MakerDeb({
      options: {
        mimeType: ["x-scheme-handler/atlarix"],
        // @ts-expect-error see the MakerRpm note above.
        icon: LINUX_HICOLOR_ICONS,
        // The same for the deb (see the MakerRpm note).
        scripts: {
          postinst: path.join(__dirname, "build/linux/deb-postinst"),
          postrm: path.join(__dirname, "build/linux/deb-postrm"),
        },
        // The computer-use executor's own libraries (see the MakerRpm note).
        depends: ["libxkbcommon0", "libwayland-client0", "libxcb1"],
      },
    }),
    new MakerAppImage({
      options: {
        mimeType: ["x-scheme-handler/atlarix"],
        icon: "./assets/icon/logo.png",
      },
    }),
  ],
  publishers: [
    {
      name: "@electron-forge/publisher-github",
      config: {
        repository: {
          owner: "AmariahAK",
          name: "atlarix-releases",
        },
        draft: true,
        force: true,
        prerelease: true,
      },
    },
  ],
  hooks: {
    packageAfterPrune: async (
      _config,
      buildPath: string,
      electronVersion: string,
      platform: string,
      arch: string,
    ) => {
      try {
        console.log(
          `[packageAfterPrune] start platform=${platform} arch=${arch} buildPath=${buildPath}`,
        );

        const mainConfigPath = path.join(process.cwd(), "vite.main.config.mts");
        const workerConfigPath = path.join(
          process.cwd(),
          "vite.worker.config.mts",
        );
        const viteMainConfig = await import(pathToFileURL(mainConfigPath).href);
        const mainExternalsFallback: string[] = Array.isArray(
          viteMainConfig.mainRollupExternals,
        )
          ? [...viteMainConfig.mainRollupExternals]
          : [];
        const raw = viteMainConfig?.default?.build?.rollupOptions?.external;
        let externalList: string[] = Array.isArray(raw)
          ? raw.map(String)
          : typeof raw === "function"
            ? mainExternalsFallback
            : mainExternalsFallback;
        try {
          const viteWorkerConfig = await import(
            pathToFileURL(workerConfigPath).href
          );
          const workerRaw =
            viteWorkerConfig?.default?.build?.rollupOptions?.external;
          if (Array.isArray(workerRaw)) {
            externalList = [...externalList, ...workerRaw.map(String)];
          }
        } catch {
          /* worker config optional */
        }
        const builtins = new Set([
          "electron",
          "fs",
          "path",
          "url",
          "stream",
          "zlib",
          "crypto",
          "os",
          "child_process",
        ]);
        const npmRoots = new Set<string>();
        for (const id of externalList) {
          if (!id || id.startsWith("node:") || builtins.has(id)) continue;
          npmRoots.add(rollupExternalIdToNpmPackageRoot(id));
        }
        const toInstall = [...npmRoots].filter((pkg) => {
          const root = pkg.startsWith("@")
            ? pkg.split("/").slice(0, 2).join("/")
            : pkg.split("/")[0];
          if (RENDERER_ONLY_PACKAGES.has(root)) return false;
          // Set entries are short names; externals often list @tanstack/* and @shikijs/*.
          if (pkg.startsWith("@tanstack/") || pkg.startsWith("@shikijs/"))
            return false;
          return true;
        });
        const fs = await import("node:fs/promises");

        // Pruned trees can still carry vitest; npm may resolve vitest@3.2.5 → missing vite-node@3.2.5.
        for (const pkg of ["vitest", "vite-node", "@vitest"]) {
          await fs.rm(path.join(buildPath, "node_modules", pkg), {
            recursive: true,
            force: true,
          });
        }

        // ── v11 SIZE FIX ────────────────────────────────────────────────────
        // `npm install <pkgs>` reconciles the FULL tree from package.json, not
        // just the named packages — a later install here was silently
        // reinstalling every prod dependency (~700MB) straight into the asar.
        // Rewrite the staged package.json to ONLY the runtime externals so no
        // npm invocation here can ever resolve the app's full dependency tree.
        const stagedPkgJsonPath = path.join(buildPath, "package.json");
        const stagedPkg = JSON.parse(
          await fs.readFile(stagedPkgJsonPath, "utf8"),
        ) as Record<string, unknown> & {
          dependencies?: Record<string, string>;
        };
        const fullDeps: Record<string, string> = stagedPkg.dependencies ?? {};
        const keepRoots = new Set<string>(toInstall);
        for (const name of toInstall) {
          if (!fullDeps[name]) {
            console.warn(
              `[packageAfterPrune] external "${name}" missing from package.json dependencies — npm will resolve latest`,
            );
          }
        }
        stagedPkg.dependencies = Object.fromEntries(
          Object.entries(fullDeps).filter(([name]) => keepRoots.has(name)),
        );
        delete stagedPkg.devDependencies;
        delete stagedPkg.optionalDependencies;
        delete stagedPkg.peerDependencies;
        // Overrides reference packages that no longer exist in the slimmed tree.
        delete stagedPkg.overrides;
        await fs.writeFile(
          stagedPkgJsonPath,
          JSON.stringify(stagedPkg, null, 2),
        );
        console.log(
          `[packageAfterPrune] slimmed staged package.json to ${Object.keys(stagedPkg.dependencies as object).length} runtime dependencies`,
        );
        // ────────────────────────────────────────────────────────────────────

        /**
         * PIN EVERY ROOT TO THE VERSION THE LOCKFILE ALREADY RESOLVED.
         *
         * This install runs with `--no-package-lock`, so a bare `name` resolves
         * that package's semver range to whatever is NEWEST at this instant. Two
         * problems follow, and only the second one is loud:
         *
         *   1. The packaged app ships versions nobody tested. `npm test` ran
         *      against the lockfile; the binary gets whatever npm felt like.
         *      That is a reproducibility hole and a supply-chain one — an
         *      unpinned newest-version install straight into a shipped artifact.
         *   2. It races publication. v14.38.3's MSIX build failed with
         *      `notarget @ai-sdk/openai@4.0.51` — a version published SEVEN
         *      SECONDS earlier, picked up from the packument before its tarball
         *      had propagated to that runner's CDN edge.
         *
         * The lockfile is the version we tested, so install exactly that. A root
         * with no lockfile entry keeps the old behaviour and says so, rather than
         * failing a release over a package we cannot pin.
         */
        // `await` and `fs.readFile`, NOT `fs.readFileSync`.
        //
        // This block has silently never worked. `const fs = await
        // import("node:fs/promises")` earlier in this hook SHADOWS the top-level
        // `import fs from "node:fs"`, and the promises API has no `readFileSync` —
        // so the try always threw, the catch always fired, and every release
        // installed all 31 roots UNPINNED ("0 pinned from package-lock" in the
        // build log, which is the tell). The staged app therefore shipped whatever
        // npm resolved at build time rather than the versions that were tested.
        const pinnedRoots: string[] = await (async () => {
          try {
            const lock = JSON.parse(
              await fs.readFile(
                path.join(process.cwd(), "package-lock.json"),
                "utf8",
              ),
            ) as { packages?: Record<string, { version?: string }> };
            const packages = lock.packages ?? {};
            return toInstall.map((name) => {
              const version = packages[`node_modules/${name}`]?.version;
              if (!version) {
                console.warn(
                  `[packageAfterPrune] "${name}" has no package-lock entry — installing UNPINNED (npm will take newest)`,
                );
                return name;
              }
              return `${name}@${version}`;
            });
          } catch (e) {
            console.warn(
              `[packageAfterPrune] could not read package-lock.json (${
                e instanceof Error ? e.message : String(e)
              }) — installing every root unpinned`,
            );
            return toInstall;
          }
        })();

        if (toInstall.length > 0) {
          console.log(
            `[packageAfterPrune] npm install (${toInstall.length} roots, ${
              pinnedRoots.filter((r) => r.includes("@", 1)).length
            } pinned from package-lock) — may take several minutes on Windows CI`,
          );
          // Omit dev + optional deps so nested tooling (Playwright, typings, etc.) does not land in the packaged app.
          const commands = [
            "install",
            "--omit=dev",
            "--omit=optional",
            "--omit=peer",
            "--no-package-lock",
            "--no-save",
            "--no-audit",
            "--no-fund",
            ...npmTargetPlatformArgs(platform, arch),
            ...pinnedRoots,
          ];
          await runNpmInstall(buildPath, commands);
        }

        // Reconcile the slimmed tree WITHOUT --omit=optional AND WITHOUT
        // --omit=peer: native platform bindings ship as optionalDependencies
        // (@lydell/node-pty-<platform> — without this the packaged PTY dies with
        // "posix_spawnp failed"), and shipped externals declare peers that they
        // require() at runtime (e.g. @ai-sdk/* → zod → "Cannot find module
        // 'zod/v4'"). Historically the ast-grep install step reconciled this
        // implicitly; that step is gone, so do it explicitly. The deny sweep
        // below runs AFTER this install, so banned transitives still never ship.
        await runNpmInstall(buildPath, [
          "install",
          "--omit=dev",
          "--no-package-lock",
          "--no-save",
          "--no-audit",
          "--no-fund",
          ...npmTargetPlatformArgs(platform, arch),
        ]);
        {
          const ptyBinding = `@lydell/node-pty-${platform}-${arch}`;
          try {
            await fs.access(path.join(buildPath, "node_modules", ptyBinding));
            console.log(
              `[packageAfterPrune] optional-deps reconcile OK (${ptyBinding} present)`,
            );
          } catch {
            throw new Error(
              `Missing ${ptyBinding} after optional-deps reconcile — the packaged terminal would be broken`,
            );
          }
          // Shipped AI SDK externals require zod/v4 at runtime (peer dep) — a
          // packaged-only "Cannot find module 'zod/v4'" if the reconcile dropped it.
          try {
            await fs.access(path.join(buildPath, "node_modules", "zod", "v4"));
          } catch {
            throw new Error(
              "Missing zod/v4 after reconcile — @ai-sdk/* would fail with 'Cannot find module zod/v4'",
            );
          }
        }

        const RENDERER_ONLY_DIRS = [
          "lucide-react",
          "date-fns",
          "posthog-js",
          "posthog-node",
          "react-shiki",
          "shiki",
          "core-js",
          "markmap-lib",
          "markmap-view",
          "markmap-common",
          "echarts",
          "zrender",
          "d3",
          "@shikijs",
          "@tanstack",
          // v11: dugite removed from dependencies; nothing to conditionally keep.
          "dugite",
        ];
        for (const pkg of RENDERER_ONLY_DIRS) {
          const pkgPath = path.join(buildPath, "node_modules", pkg);
          await fs.rm(pkgPath, { recursive: true, force: true });
        }

        for (const pkg of RELEASE_DENY_PACKAGES) {
          const pkgPath = path.join(buildPath, "node_modules", pkg);
          await fs.rm(pkgPath, { recursive: true, force: true });
        }
        // v11: geist is no longer a dependency (fonts vendored); rm guards stale trees.
        for (const pkg of ["next", "@next", "geist"]) {
          await fs.rm(path.join(buildPath, "node_modules", pkg), {
            recursive: true,
            force: true,
          });
        }
        await fs.rm(path.join(buildPath, "node_modules", "@playwright"), {
          recursive: true,
          force: true,
        });
        await fs.rm(path.join(buildPath, "node_modules", "@vitest"), {
          recursive: true,
          force: true,
        });

        // npm installs above reconcile the (slimmed) package.json, which can
        // resurrect deny-listed transitives — e.g. typescript (23MB). Re-run the
        // deny sweep AFTER the last install so nothing banned ships.
        for (const pkg of RELEASE_DENY_PACKAGES) {
          await fs.rm(path.join(buildPath, "node_modules", pkg), {
            recursive: true,
            force: true,
          });
        }

        // On Windows CI, force rebuild after npm install — ABI skip checks can throw when
        // forge's rebuildConfig ran before hook-installed modules landed.
        const rebuildForce =
          platform === "win32" && process.env.GITHUB_ACTIONS === "true";
        const rebuildModules = ["better-sqlite3", "@lydell/node-pty"];

        await rebuild({
          buildPath,
          electronVersion,
          platform: platform as NodeJS.Platform,
          arch,
          force: rebuildForce,
          extraModules: rebuildModules,
        });

        await stripSourceMapsFromBuild(buildPath);
        console.log(`[packageAfterPrune] done buildPath=${buildPath}`);
      } catch (err) {
        console.error("[packageAfterPrune] FATAL ERROR:", err);
        if (err instanceof Error && err.stack) {
          console.error(err.stack);
        }
        process.exitCode = 1;
        process.exit(1);
      }
    },
    // Local macOS builds: electron-packager ad-hoc signs the bundle, but our
    // packageAfterPrune step strips files AFTER signing, invalidating the
    // signature → macOS kills the app on launch ("Code Signature Invalid").
    // Re-sign ad-hoc + clear quarantine so local builds run. Skipped in CI,
    // where the maker pipeline signs/notarizes properly. Generic — operates on
    // whatever .app is in the output dir.
    postPackage: async (
      _forgeConfig: unknown,
      options: { platform: string; outputPaths?: string[] },
    ) => {
      if (options.platform !== "darwin" || process.env.CI) return;
      const { execFileSync } = await import("node:child_process");
      const fsp = await import("node:fs/promises");
      for (const outDir of options.outputPaths ?? []) {
        let appName: string | undefined;
        try {
          appName = (await fsp.readdir(outDir)).find((f) => f.endsWith(".app"));
        } catch {
          continue;
        }
        if (!appName) continue;
        const appPath = path.join(outDir, appName);
        // Re-sign with the Developer ID when it's in this keychain, as osxSign
        // did before the prune. Ad-hoc identities change every build, so the
        // keychain asked for the login password at each launch ("Atlarix Safe
        // Storage") and no "Always Allow" ever carried over (QA, build I). The
        // CLI's local builds do the same (build-bun.ts). Ad-hoc without it.
        const identity = "Developer ID Application: Amariah Kamau (7VWW7N9R87)";
        let haveIdentity = false;
        try {
          haveIdentity = execFileSync(
            "security",
            ["find-identity", "-v", "-p", "codesigning"],
            { encoding: "utf8" },
          ).includes(identity);
        } catch {
          haveIdentity = false;
        }
        // A failed re-sign used to be logged as non-fatal and the build went on
        // with a bundle that was partly ad-hoc (libffmpeg, libEGL, better-sqlite3,
        // node-pty) while `codesign --verify --deep` still passed; under the
        // hardened runtime that crashes at load on a Team ID mismatch (2026-10-30,
        // a timestamp-service outage). Now: retry the short outages, then check
        // every Mach-O on its own, re-sign any that is off, and fail the build if
        // one still is.
        const sign = async (args: string[], what: string) => {
          const waits = [15, 30, 60];
          for (let attempt = 0; ; attempt++) {
            try {
              execFileSync("codesign", args, { stdio: "inherit" });
              return;
            } catch (err) {
              if (attempt >= waits.length) {
                throw new Error(
                  `[postPackage] signing ${what} failed after ${attempt + 1} tries: ${String(err)}`,
                );
              }
              console.warn(
                `[postPackage] signing ${what} failed (try ${attempt + 1}), retrying in ${waits[attempt]}s: ${String(err)}`,
              );
              await new Promise((r) => setTimeout(r, waits[attempt] * 1000));
            }
          }
        };
        const bundleArgs = haveIdentity
          ? [
              "--force",
              "--deep",
              "--options",
              "runtime",
              "--entitlements",
              path.join(__dirname, "entitlements.plist"),
              "--sign",
              identity,
              appPath,
            ]
          : ["--force", "--deep", "--sign", "-", appPath];
        await sign(bundleArgs, appPath);
        if (haveIdentity) {
          const { scanTeamIds } = await import(
            pathToFileURL(path.join(__dirname, "scripts", "mac-team-id.mjs"))
              .href
          );
          let { checked, off } = scanTeamIds(appPath);
          if (off.length) {
            // `--deep` skips loose Mach-O files under Resources (.node, rg,
            // spawn-helper): sign each one, innermost first, then the bundle.
            for (const { file, signer } of [...off].sort(
              (a, b) => b.file.length - a.file.length,
            )) {
              console.warn(`[postPackage] ${file} was ${signer}; re-signing`);
              await sign(
                [
                  "--force",
                  "--options",
                  "runtime",
                  "--sign",
                  identity,
                  path.join(appPath, file),
                ],
                file,
              );
            }
            await sign(bundleArgs, appPath);
            ({ checked, off } = scanTeamIds(appPath));
          }
          if (off.length) {
            throw new Error(
              `[postPackage] ${off.length} of ${checked} Mach-O file(s) lack Team ID 7VWW7N9R87:\n${off
                .map((o: { file: string; signer: string }) => `  ${o.signer}\t${o.file}`)
                .join("\n")}`,
            );
          }
          console.log(
            `[postPackage] Team ID 7VWW7N9R87 on all ${checked} Mach-O file(s)`,
          );
        }
        execFileSync("xattr", ["-cr", appPath]);
        console.log(
          `[postPackage] ${haveIdentity ? "Developer ID" : "ad-hoc"} re-signed local build: ${appPath}`,
        );
      }
    },
  },
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: "src/main.ts",
          config: "vite.main.config.mts",
          target: "main",
        },
        {
          entry: "src/preload.ts",
          config: "vite.preload.config.mts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.mts",
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      // Hard false. This used to be `isEndToEndTestBuild`, i.e. a build-time env
      // var could ship a package with --inspect enabled. Nothing sets that var
      // any more (the Playwright suite that did is gone), and no shipped build
      // should ever want it.
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
