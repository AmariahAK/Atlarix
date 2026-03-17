import type { ForgeConfig } from "@electron-forge/shared-types";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import rebuild from "@electron/rebuild";

// Based on https://github.com/electron/forge/blob/6b2d547a7216c30fde1e1fddd1118eee5d872945/packages/plugin/vite/src/VitePlugin.ts#L124
const ignore = (file: string) => {
  if (!file) return false;
  // `file` always starts with `/`
  // @see - https://github.com/electron/packager/blob/v18.1.3/src/copy-filter.ts#L89-L93
  if (file === "/node_modules") {
    return false;
  }
  if (file.startsWith("/drizzle")) {
    return false;
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
    protocols: [
      {
        name: "Atlarix",
        schemes: ["atlarix"],
      },
    ],
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
    extraResource: ["node_modules/dugite/git"],
    // ignore: [/node_modules\/(?!(better-sqlite3|bindings|file-uri-to-path)\/)/],
  },
  rebuildConfig: {
    extraModules: ["better-sqlite3"],
    force: true,
  },
  makers: [
    new MakerSquirrel({
      // Only sign if certificate is provided
      ...(process.env.SM_CODE_SIGNING_CERT_SHA1_HASH ? {
        signWithParams: `/sha1 ${process.env.SM_CODE_SIGNING_CERT_SHA1_HASH} /tr http://timestamp.digicert.com /td SHA256 /fd SHA256`,
      } : {}),
    }),
    new MakerDMG(),
    new MakerRpm({}),
    new MakerDeb({
      options: {
        mimeType: ["x-scheme-handler/atlarix"],
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
      const viteMainConfig = await import(pathToFileURL(mainConfigPath).href);
      const raw =
        viteMainConfig?.default?.build?.rollupOptions?.external;
      const externalList: string[] = Array.isArray(raw)
        ? raw
        : typeof raw === "function"
          ? [
              "better-sqlite3",
              "mysql2",
              "ai",
              "@ai-sdk/provider",
              "@ai-sdk/openai",
              "@ai-sdk/anthropic",
              "@ai-sdk/google",
              "@ai-sdk/google-vertex",
              "@ai-sdk/azure",
              "@ai-sdk/xai",
              "@ai-sdk/amazon-bedrock",
              "@ai-sdk/openai-compatible",
              "@ai-sdk/provider-utils",
            ]
          : [];
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
      const toInstall = externalList.filter(
        (id) => !id.startsWith("node:") && !builtins.has(id)
      );
      if (toInstall.length > 0) {
        const commands = ["install", "--no-package-lock", "--no-save", ...toInstall];
        await new Promise<void>((resolve, reject) => {
          const proc = spawn("npm", commands, {
            cwd: buildPath,
            stdio: "inherit",
            shell: false,
          });
          proc.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`npm install exited with code ${code}`));
          });
          proc.on("error", reject);
        });
      }
      // Rebuild native modules (e.g. better-sqlite3) for Electron's Node ABI after
      // npm install, which otherwise builds them for the host Node (NODE_MODULE_VERSION mismatch).
      await rebuild({
        buildPath,
        electronVersion,
        platform: platform as NodeJS.Platform,
        arch,
        force: true,
        extraModules: ["better-sqlite3"],
      });
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