import type { ForgeConfig } from "@electron-forge/shared-types";
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

/** Windows resolves npm via `npm.cmd`; spawn with shell:false cannot execute it as `npm`. */
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function runNpmInstall(cwd: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(npm, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
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
  "mermaid",
]);

// Based on https://github.com/electron/forge/blob/6b2d547a7216c30fde1e1fddd1118eee5d872945/packages/plugin/vite/src/VitePlugin.ts#L124
const ignore = (file: string) => {
  if (!file) return false;
  // `file` always starts with `/`
  // @see - https://github.com/electron/packager/blob/v18.1.3/src/copy-filter.ts#L89-L93
  if (file === "/node_modules") {
    return false;
  }
  // drizzle/*.sql is bundled into the main process via Vite ?raw — omit from asar to shrink the package.
  if (file.startsWith("/drizzle")) {
    return true;
  }
  if (file.startsWith("/scaffold")) {
    return false;
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
  if (file.startsWith("/node_modules/keytar")) {
    return false;
  }
  if (file.startsWith("/node_modules/@ast-grep")) {
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
  if (file.startsWith("/node_modules/mermaid")) return true;
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

const isEndToEndTestBuild = process.env.E2E_TEST_BUILD === "true";

const config: ForgeConfig = {
  packagerConfig: {
    // Electron Packager supports this flag even though Forge's type lags behind.
    // @ts-expect-error chromiumSandbox is forwarded to electron-packager
    chromiumSandbox: false,
    protocols: [
      {
        name: "Atlarix",
        schemes: ["atlarix"],
      },
    ],
    /** App icon basename; Packager resolves `.icns` / `.ico` / `.png` per platform from `assets/icon/logo.*`. */
    icon: "./assets/icon/logo",
    executableName: "atlarix", // Fixes Linux 'could not find binary' error (case sensitivity)

    osxSign: isEndToEndTestBuild
      ? undefined
      : {
          identity: "Developer ID Application: Amariah Kamau (7VWW7N9R87)",
          optionsForFile: () => ({
            entitlements: "./entitlements.plist",
            "entitlements-inherit": "./entitlements.plist",
            "hardened-runtime": true,
          }),
        },
    osxNotarize: undefined,
    asar: true,
    ignore,
    extraResource: [
      "node_modules/dugite/git",
      path.join(__dirname, "src/skills"),
      path.join(__dirname, "assets/ctags", process.platform === "darwin"
        ? (process.arch === "arm64" ? "darwin-arm64" : "darwin-x64")
        : process.platform === "win32"
          ? "win32-x64"
          : process.arch === "arm64"
            ? "linux-arm64"
            : "linux-x64"),
    ],
    // ignore: [/node_modules\/(?!(better-sqlite3|bindings|file-uri-to-path)\/)/],
  },
  rebuildConfig: {
    extraModules: [
      "better-sqlite3",
      "keytar",
      "@lydell/node-pty",
      "@ast-grep/napi",
    ],
    force: true,
  },
  makers: [
    new MakerSquirrel((process.env.SM_CODE_SIGNING_CERT_SHA1_HASH ? {
        signWithParams: `/sha1 ${process.env.SM_CODE_SIGNING_CERT_SHA1_HASH} /tr http://timestamp.digicert.com /td SHA256 /fd SHA256`,
      } : {
        setupIcon: "./assets/icon/logo.ico",
      })),
    new MakerDMG({
      icon: "./assets/icon/logo.icns",
    }),
    new MakerZIP({}, ["darwin"]),
    new MakerRpm({
      options: {
        mimeType: ["x-scheme-handler/atlarix"],
      },
    }),
    new MakerDeb({
      options: {
        mimeType: ["x-scheme-handler/atlarix"],
      },
    }),
    new MakerAppImage({
      options: {
        // AppImage supports auto-update natively via electron-updater
        // and avoids deep-link registration friction on minimal distros / VMs.
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
      const mainConfigPath = path.join(process.cwd(), "vite.main.config.mts");
      const workerConfigPath = path.join(process.cwd(), "vite.worker.config.mts");
      const viteMainConfig = await import(pathToFileURL(mainConfigPath).href);
      const mainExternalsFallback: string[] = Array.isArray(viteMainConfig.mainRollupExternals)
        ? [...viteMainConfig.mainRollupExternals]
        : [];
      const raw = viteMainConfig?.default?.build?.rollupOptions?.external;
      let externalList: string[] = Array.isArray(raw)
        ? raw.map(String)
        : typeof raw === "function"
          ? mainExternalsFallback
          : mainExternalsFallback;
      try {
        const viteWorkerConfig = await import(pathToFileURL(workerConfigPath).href);
        const workerRaw = viteWorkerConfig?.default?.build?.rollupOptions?.external;
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
      if (toInstall.length > 0) {
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
          ...toInstall,
        ];
        await runNpmInstall(buildPath, commands);
      }

      // Rebuild native modules (e.g. better-sqlite3) for Electron's Node ABI after
      // npm install, which otherwise builds them for the host Node (NODE_MODULE_VERSION mismatch).
      await rebuild({
        buildPath,
        electronVersion,
        platform: platform as NodeJS.Platform,
        arch,
        force: true,
        extraModules: [
          "better-sqlite3",
          "keytar",
          "@lydell/node-pty",
        ],
      });

      // After rebuild: remove renderer-only trees from pruned node_modules before asar is produced.
      // Never delete runtime externals (see vite.main.config `mainRollupExternals`) — e.g. drizzle-orm.
      const fs = await import("node:fs/promises");
      const RENDERER_ONLY_DIRS = [
        "lucide-react",
        "date-fns",
        "posthog-js",
        "posthog-node",
        "react-shiki",
        "shiki",
        "core-js",
        "mermaid",
        "@shikijs",
        "@tanstack",
      ];
      for (const pkg of RENDERER_ONLY_DIRS) {
        const pkgPath = path.join(buildPath, "node_modules", pkg);
        await fs.rm(pkgPath, { recursive: true, force: true });
      }
    },
  },
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: "src/main.ts",
          config: "vite.main.config.mts",
          target: "main",
        },
        {
          entry: "src/preload.ts",
          config: "vite.preload.config.mts",
          target: "preload",
        },
        {
          entry: "workers/tsc/tsc_worker.ts",
          config: "vite.worker.config.mts",
          target: "main",
        },
        {
          entry: "workers/blueprint/astgrep_worker.ts",
          config: "vite.astgrep-worker.config.mts",
          target: "main",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.mts",
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: isEndToEndTestBuild,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;