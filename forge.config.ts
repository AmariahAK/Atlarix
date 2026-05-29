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

/** Windows resolves npm via `npm.cmd`; spawn with shell:false cannot execute it as `npm`. */
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

/** Set ATLARIX_PACKAGING_DEBUG=1 or run on GitHub Actions for step timing + failure logs. */
function shouldLogPackaging(): boolean {
  return (
    process.env.ATLARIX_PACKAGING_DEBUG === "1" ||
    process.env.ATLARIX_PACKAGING_DEBUG === "true" ||
    process.env.GITHUB_ACTIONS === "true"
  );
}

function packagingLog(step: string, detail?: Record<string, unknown>): void {
  if (!shouldLogPackaging()) return;
  const ts = new Date().toISOString();
  const mem = process.memoryUsage();
  const prefix = `[atlarix-packaging] ${ts} ${step} rss=${Math.round(mem.rss / 1e6)}MiB heap=${Math.round(mem.heapUsed / 1e6)}MiB`;
  if (detail === undefined) {
    console.log(prefix);
    return;
  }
  console.log(`${prefix} ${JSON.stringify(detail)}`);
}

async function packagingStep<T>(step: string, fn: () => Promise<T>): Promise<T> {
  if (!shouldLogPackaging()) return fn();
  packagingLog(`${step} begin`);
  const t0 = Date.now();
  try {
    const result = await fn();
    packagingLog(`${step} done`, { ms: Date.now() - t0 });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    packagingLog(`${step} FAILED`, {
      ms: Date.now() - t0,
      error: message,
      stack: stack?.split("\n").slice(0, 10),
    });
    throw err;
  }
}

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

/** @ast-grep/napi platform .node bindings are optionalDependencies — never install with --omit=optional. */
const AST_GREP_RUNTIME_PACKAGES = [
  "@ast-grep/napi",
  "@ast-grep/lang-python",
  "@ast-grep/lang-go",
] as const;

/** Copied to Resources/ast-grep-grammars via extraResource (real FS path for parser.so). */
const AST_GREP_GRAMMARS_STAGING = path.join(__dirname, "ast-grep-grammars");
if (!fs.existsSync(AST_GREP_GRAMMARS_STAGING)) {
  fs.mkdirSync(AST_GREP_GRAMMARS_STAGING, { recursive: true });
}

function astGrepPrebuildDir(platform: string, arch: string): string {
  const os =
    platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform === "linux" ? "Linux" : null;
  const a = arch === "x64" ? "X64" : arch === "arm64" ? "ARM64" : null;
  if (!os || !a) return `prebuild-${platform}-${arch}`;
  return `prebuild-${os}-${a}`;
}

/** @ast-grep/lang-* prebuilds use `parser.so` on every OS (see @ast-grep/setup-lang). */
const AST_GREP_PARSER_FILE = "parser.so";

async function resolveAstGrepParserSource(
  buildPath: string,
  pkg: string,
  platform: string,
  arch: string,
): Promise<string> {
  const fs = await import("node:fs/promises");
  const prebuild = astGrepPrebuildDir(platform, arch);
  const pkgRoot = path.join(buildPath, "node_modules", pkg);
  const primary = path.join(pkgRoot, "prebuilds", prebuild, AST_GREP_PARSER_FILE);
  try {
    await fs.access(primary);
    return primary;
  } catch {
    const prebuildsDir = path.join(pkgRoot, "prebuilds");
    let listing = "";
    try {
      listing = (await fs.readdir(prebuildsDir)).join(", ");
    } catch {
      listing = "(prebuilds missing)";
    }
    throw new Error(
      `Missing ${AST_GREP_PARSER_FILE} for ${pkg} at ${primary}. prebuilds: ${listing}`,
    );
  }
}

async function stageAstGrepGrammarsForExtraResource(
  buildPath: string,
  platform: string,
  arch: string,
): Promise<void> {
  const fs = await import("node:fs/promises");
  await fs.rm(AST_GREP_GRAMMARS_STAGING, { recursive: true, force: true });
  await fs.mkdir(AST_GREP_GRAMMARS_STAGING, { recursive: true });

  const langs: Array<{ key: string; pkg: string }> = [
    { key: "python", pkg: "@ast-grep/lang-python" },
    { key: "go", pkg: "@ast-grep/lang-go" },
  ];

  for (const { key, pkg } of langs) {
    const src = await resolveAstGrepParserSource(buildPath, pkg, platform, arch);
    const dest = path.join(AST_GREP_GRAMMARS_STAGING, key, AST_GREP_PARSER_FILE);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
  }
  console.log(`[packageAfterPrune] staged ast-grep grammars at ${AST_GREP_GRAMMARS_STAGING}`);
}

function astGrepNativeBindingPackage(platform: string, arch: string): string | null {
  if (platform === "darwin") {
    if (arch === "arm64") return "@ast-grep/napi-darwin-arm64";
    if (arch === "x64") return "@ast-grep/napi-darwin-x64";
    return null;
  }
  if (platform === "win32") {
    if (arch === "x64") return "@ast-grep/napi-win32-x64-msvc";
    if (arch === "arm64") return "@ast-grep/napi-win32-arm64-msvc";
    return null;
  }
  if (platform === "linux") {
    // GitHub ubuntu-latest and typical Linux desktop targets use glibc (gnu).
    if (arch === "x64") return "@ast-grep/napi-linux-x64-gnu";
    if (arch === "arm64") return "@ast-grep/napi-linux-arm64-gnu";
    return null;
  }
  return null;
}

async function readPinnedDependencyVersions(
  buildPath: string,
  packageNames: readonly string[],
): Promise<string[]> {
  const fs = await import("node:fs/promises");
  const pkg = JSON.parse(
    await fs.readFile(path.join(buildPath, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const deps = pkg.dependencies ?? {};
  return packageNames
    .filter((name) => deps[name])
    .map((name) => `${name}@${String(deps[name]).trim()}`);
}

async function installAstGrepRuntimePackages(
  buildPath: string,
  platform: string,
  arch: string,
): Promise<void> {
  const pinned = await readPinnedDependencyVersions(buildPath, AST_GREP_RUNTIME_PACKAGES);
  if (pinned.length === 0) return;

  await runNpmInstall(buildPath, [
    "install",
    "--omit=dev",
    "--no-package-lock",
    "--no-save",
    "--no-audit",
    "--no-fund",
    ...npmTargetPlatformArgs(platform, arch),
    ...pinned,
  ]);

  const bindingPkg = astGrepNativeBindingPackage(platform, arch);
  if (!bindingPkg) return;
  const fs = await import("node:fs/promises");
  const bindingDir = path.join(buildPath, "node_modules", bindingPkg);
  try {
    await fs.access(bindingDir);
  } catch {
    throw new Error(
      `Missing ${bindingPkg} after ast-grep install (optional native binding for ${platform}/${arch})`,
    );
  }
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

const isEndToEndTestBuild = process.env.E2E_TEST_BUILD === "true";

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
  if (file === "/node_modules") {
    return false;
  }
  // drizzle/*.sql is bundled into the main process via Vite ?raw — omit from asar to shrink the package.
  if (file.startsWith("/drizzle")) {
    return true;
  }
  if (file.startsWith("/scaffold")) {
    return !isEndToEndTestBuild;
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
  if (file.startsWith("/node_modules/echarts")) return true;
  if (file.startsWith("/node_modules/zrender")) return true;
  // geist depends on next (~200MB); ship font files only (see globals.css paths).
  if (file.startsWith("/node_modules/geist/dist")) return false;
  if (file.startsWith("/node_modules/geist")) return true;
  if (file.startsWith("/node_modules/next")) return true;
  if (file.startsWith("/node_modules/@next")) return true;
  if (file.startsWith("/node_modules/dugite")) return true;
  for (const deny of RELEASE_DENY_PACKAGES) {
    if (file === `/node_modules/${deny}` || file.startsWith(`/node_modules/${deny}/`)) {
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
  await walk(path.join(buildPath, ".vite"));
  await walk(path.join(buildPath, "node_modules"));
  if (removed > 0) {
    console.log(`[packageAfterPrune] removed ${removed} .map file(s)`);
  }
  return removed;
}

async function logTopNodeModules(buildPath: string, limit = 20): Promise<void> {
  const fs = await import("node:fs/promises");
  const { execSync } = await import("node:child_process");
  const nm = path.join(buildPath, "node_modules");
  try {
    const out = execSync(`du -sh "${nm}"/* 2>/dev/null | sort -hr | head -${limit}`, {
      encoding: "utf8",
    });
    console.log(`[packageAfterPrune] top node_modules:\n${out}`);
  } catch {
    /* optional */
  }
  void fs;
}

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
    asarUnpack: [
      "**/@ast-grep/napi-darwin-*/**",
      "**/@ast-grep/napi-linux-*/**",
      "**/@ast-grep/napi-win32-*/**",
      "**/@ast-grep/lang-python/**",
      "**/@ast-grep/lang-go/**",
      "**/.vite/build/astgrep_worker.js",
    ],
    ignore,
    extraResource: [
      ...(isEndToEndTestBuild || process.env.ATLARIX_BUNDLE_GIT === "1"
        ? ["node_modules/dugite/git"]
        : []),
      AST_GREP_GRAMMARS_STAGING,
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
    prePackage: async (_config, platform, arch) => {
      packagingLog("hook.prePackage", {
        platform,
        arch,
        cwd: process.cwd(),
        ci: process.env.CI ?? "(unset)",
        nodeOptions: process.env.NODE_OPTIONS ?? "(unset)",
      });
    },
    packageAfterCopy: async (_config, buildPath, electronVersion, platform, arch) => {
      packagingLog("hook.packageAfterCopy", {
        buildPath,
        electronVersion,
        platform,
        arch,
      });
    },
    packageAfterExtract: async (_config, buildPath, electronVersion, platform, arch) => {
      packagingLog("hook.packageAfterExtract", {
        buildPath,
        electronVersion,
        platform,
        arch,
      });
    },
    packageAfterPrune: async (
      _config,
      buildPath: string,
      electronVersion: string,
      platform: string,
      arch: string,
    ) => {
      packagingLog("hook.packageAfterPrune start", {
        buildPath,
        electronVersion,
        platform,
        arch,
      });
      try {
        const toInstall = await packagingStep("resolve-externals", async () => {
          const mainConfigPath = path.join(process.cwd(), "vite.main.config.mts");
          const workerConfigPath = path.join(process.cwd(), "vite.worker.config.mts");
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
            const viteWorkerConfig = await import(pathToFileURL(workerConfigPath).href);
            const workerRaw = viteWorkerConfig?.default?.build?.rollupOptions?.external;
            if (Array.isArray(workerRaw)) {
              externalList = [...externalList, ...workerRaw.map(String)];
            }
          } catch {
            packagingLog("resolve-externals.worker-config-skipped");
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
          const astGrepRoots = new Set<string>(AST_GREP_RUNTIME_PACKAGES);
          const roots = [...npmRoots].filter((pkg) => {
            const root = pkg.startsWith("@")
              ? pkg.split("/").slice(0, 2).join("/")
              : pkg.split("/")[0];
            if (RENDERER_ONLY_PACKAGES.has(root)) return false;
            if (astGrepRoots.has(root)) return false;
            if (pkg.startsWith("@tanstack/") || pkg.startsWith("@shikijs/"))
              return false;
            return true;
          });
          packagingLog("resolve-externals.result", {
            externalCount: externalList.length,
            installCount: roots.length,
            sample: roots.slice(0, 12),
          });
          return roots;
        });

        const fs = await import("node:fs/promises");

        if (toInstall.length > 0) {
          await packagingStep("npm-install-pruned", async () => {
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
              ...toInstall,
            ];
            packagingLog("npm-install-pruned.command", { cwd: buildPath, packages: toInstall.length });
            await runNpmInstall(buildPath, commands);
          });
        }

        await packagingStep("prune-renderer-dirs", async () => {
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
            ...(isEndToEndTestBuild || process.env.ATLARIX_BUNDLE_GIT === "1" ? [] : ["dugite"]),
          ];
          for (const pkg of RENDERER_ONLY_DIRS) {
            await fs.rm(path.join(buildPath, "node_modules", pkg), {
              recursive: true,
              force: true,
            });
          }
        });

        await packagingStep("prune-deny-packages", async () => {
          for (const pkg of RELEASE_DENY_PACKAGES) {
            await fs.rm(path.join(buildPath, "node_modules", pkg), {
              recursive: true,
              force: true,
            });
          }
          for (const pkg of ["next", "@next"]) {
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
        });

        await packagingStep("ast-grep-runtime", async () => {
          await installAstGrepRuntimePackages(buildPath, platform, arch);
          await stageAstGrepGrammarsForExtraResource(buildPath, platform, arch);
        });

        await packagingStep("rebuild-native-modules", async () => {
          const bindingPkg = astGrepNativeBindingPackage(platform, arch);
          const rebuildModules = [
            "better-sqlite3",
            "keytar",
            "@lydell/node-pty",
            "@ast-grep/napi",
          ];
          if (bindingPkg) rebuildModules.push(bindingPkg);
          packagingLog("rebuild-native-modules.targets", { rebuildModules });
          await rebuild({
            buildPath,
            electronVersion,
            platform: platform as NodeJS.Platform,
            arch,
            force: true,
            extraModules: rebuildModules,
          });
        });

        await packagingStep("strip-maps-and-report", async () => {
          await stripSourceMapsFromBuild(buildPath);
          await logTopNodeModules(buildPath);
        });

        packagingLog("hook.packageAfterPrune complete", { buildPath, platform, arch });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        packagingLog("hook.packageAfterPrune FATAL", { error: message, stack });
        throw err;
      }
    },
    postPackage: async (_config, packageResult) => {
      packagingLog("hook.postPackage", {
        platform: packageResult.platform,
        arch: packageResult.arch,
        outputPaths: packageResult.outputPaths,
      });
    },
    preMake: async () => {
      packagingLog("hook.preMake", { cwd: process.cwd() });
    },
    postMake: async (_config, makeResults) => {
      packagingLog("hook.postMake", {
        artifactGroups: makeResults.length,
        artifacts: makeResults.flatMap((r) => r.artifacts ?? []).map((a) => path.basename(a)),
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