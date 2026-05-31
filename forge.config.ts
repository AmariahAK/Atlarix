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

function packagingNodeOptions(): string | undefined {
  if (process.env.NODE_OPTIONS) return process.env.NODE_OPTIONS;
  if (process.env.GITHUB_ACTIONS === "true" && process.platform === "win32") {
    return "--max-old-space-size=4096";
  }
  return undefined;
}

function runNpmInstall(cwd: string, args: string[]): Promise<void> {
  const nodeOptions = packagingNodeOptions();
  const useShell = process.platform === "win32";
  return new Promise<void>((resolve, reject) => {
    const proc = spawn("npm", args, {
      cwd,
      stdio: "inherit",
      shell: useShell,
      env: nodeOptions
        ? { ...process.env, NODE_OPTIONS: nodeOptions }
        : process.env,
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

/** Windows file locking can make fs.rm throw EBUSY/EPERM — retry with backoff. */
async function resetStagingDir(dirPath: string): Promise<void> {
  const fsp = await import("node:fs/promises");
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fsp.rm(dirPath, { recursive: true, force: true });
      break;
    } catch (err: unknown) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as NodeJS.ErrnoException).code)
          : "";
      if (attempt === 4) throw err;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw err;
      console.log(
        `[packageAfterPrune] rm ${code} on ${dirPath}, retry ${attempt + 1}/4…`,
      );
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  await fsp.mkdir(dirPath, { recursive: true });
}

async function stageAstGrepGrammarsForExtraResource(
  buildPath: string,
  platform: string,
  arch: string,
): Promise<void> {
  const fs = await import("node:fs/promises");
  await resetStagingDir(AST_GREP_GRAMMARS_STAGING);

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
  // Production Vite builds disable sourcemaps; avoid walking all of node_modules on CI (high RAM).
  await walk(path.join(buildPath, ".vite", "build"));
  if (removed > 0) {
    console.log(`[packageAfterPrune] removed ${removed} .map file(s)`);
  }
  return removed;
}

type PackagingDiagModule = typeof import("./scripts/packaging-diagnostics.mjs");

let packagingDiagPromise: Promise<PackagingDiagModule> | null = null;

function loadPackagingDiagnostics(): Promise<PackagingDiagModule> {
  packagingDiagPromise ??= import(
    pathToFileURL(path.join(__dirname, "scripts/packaging-diagnostics.mjs")).href
  ) as Promise<PackagingDiagModule>;
  return packagingDiagPromise;
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

    // osxSign must not be set on win32/linux — packager may invoke codesign and fail silently when quiet:true.
    osxSign:
      isEndToEndTestBuild || process.platform !== "darwin"
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
    // Forge defaults quiet:true; on CI surface packager/asar stderr (see electron-forge packageOpts).
    // @ts-expect-error quiet is forwarded to electron-packager
    quiet: process.env.GITHUB_ACTIONS !== "true",
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
    postPackage: async (_config, packageResult) => {
      const diag = await loadPackagingDiagnostics();
      const outputPaths: string[] = (packageResult as { outputPaths?: string[] }).outputPaths ?? [];
      diag.logPackagingStep("postPackage:done", {
        detail: `outputPaths=${JSON.stringify(outputPaths)}`,
      });
      for (const p of outputPaths) {
        diag.logBuildPathSizes(p, "postPackage output dir");
      }
    },
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
      const diag = await loadPackagingDiagnostics();
      diag.logPackagingStep("packageAfterPrune:start", { buildPath });
      diag.logBuildPathSizes(buildPath, "after prune (before npm install)");

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
      const astGrepRoots = new Set<string>(AST_GREP_RUNTIME_PACKAGES);
      const toInstall = [...npmRoots].filter((pkg) => {
        const root = pkg.startsWith("@")
          ? pkg.split("/").slice(0, 2).join("/")
          : pkg.split("/")[0];
        if (RENDERER_ONLY_PACKAGES.has(root)) return false;
        if (astGrepRoots.has(root)) return false;
        // Set entries are short names; externals often list @tanstack/* and @shikijs/*.
        if (pkg.startsWith("@tanstack/") || pkg.startsWith("@shikijs/"))
          return false;
        return true;
      });
      const fs = await import("node:fs/promises");

      diag.logToInstallSummary(toInstall);

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
          ...npmTargetPlatformArgs(platform, arch),
          ...toInstall,
        ];
        await runNpmInstall(buildPath, commands);
        diag.logPackagingStep("packageAfterPrune:after-externals-npm-install", {
          buildPath,
        });
        diag.logBuildPathSizes(buildPath, "after externals npm install");
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
        ...(isEndToEndTestBuild || process.env.ATLARIX_BUNDLE_GIT === "1" ? [] : ["dugite"]),
      ];
      for (const pkg of RENDERER_ONLY_DIRS) {
        const pkgPath = path.join(buildPath, "node_modules", pkg);
        await fs.rm(pkgPath, { recursive: true, force: true });
      }

      for (const pkg of RELEASE_DENY_PACKAGES) {
        const pkgPath = path.join(buildPath, "node_modules", pkg);
        await fs.rm(pkgPath, { recursive: true, force: true });
      }
      // geist → next is optional; fonts live under geist/dist only.
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

      diag.logPackagingStep("packageAfterPrune:after-renderer-deny-prune", { buildPath });

      // ast-grep optional platform bindings (@ast-grep/napi-darwin-arm64, etc.) — never run npm prune after this.
      await installAstGrepRuntimePackages(buildPath, platform, arch);
      diag.logPackagingStep("packageAfterPrune:after-astgrep-npm-install", { buildPath });
      await stageAstGrepGrammarsForExtraResource(buildPath, platform, arch);
      diag.logPackagingStep("packageAfterPrune:after-astgrep-grammars-staged", { buildPath });

      const bindingPkg = astGrepNativeBindingPackage(platform, arch);
      // On Windows CI, force rebuild after npm install — ABI skip checks can throw when
      // forge's rebuildConfig ran before hook-installed modules landed.
      const rebuildForce =
        platform === "win32" && process.env.GITHUB_ACTIONS === "true";
      const rebuildModules = [
        "better-sqlite3",
        "keytar",
        "@lydell/node-pty",
        "@ast-grep/napi",
      ];
      if (bindingPkg) rebuildModules.push(bindingPkg);

      await rebuild({
        buildPath,
        electronVersion,
        platform: platform as NodeJS.Platform,
        arch,
        force: rebuildForce,
        extraModules: rebuildModules,
      });

      diag.logPackagingStep("packageAfterPrune:after-native-rebuild", { buildPath });
      diag.logBuildPathSizes(buildPath, "after native rebuild");

      const mapsRemoved = await stripSourceMapsFromBuild(buildPath);
      diag.logPackagingStep("packageAfterPrune:after-strip-sourcemaps", {
        buildPath,
        detail: `removed ${mapsRemoved} .map file(s)`,
      });

      diag.logTopNodeModules(buildPath);
      diag.logPackagingStep("packageAfterPrune:done", { buildPath });
      } catch (err) {
        console.error("[packageAfterPrune] FATAL ERROR:", err);
        if (err instanceof Error && err.stack) {
          console.error(err.stack);
        }
        process.exitCode = 1;
        process.exit(1);
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
