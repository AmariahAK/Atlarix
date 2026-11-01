#!/usr/bin/env bun
/**
 * Compile the Atlarix CLI into ONE self-contained executable with Bun.
 *
 * Same graph as scripts/build-headless.mjs (the esbuild/Node build, which stays
 * for npm and benchmarks until this one replaces it), with the differences a
 * compiled binary needs:
 *
 *  - the resolution rules in scripts/bun-cli-plugin.ts (better-sqlite3 on
 *    bun:sqlite, tiktoken's wasm, the electron stubs);
 *  - runtime files (AGENTS.md, tiktoken's wasm, the models.dev snapshot,
 *    ripgrep) EMBEDDED and reached through the generated `atlarix:assets`
 *    module. `__dirname` cannot find them: Bun freezes it to the BUILD
 *    machine's source path, so a lookup relative to it only works where the
 *    binary was built.
 *
 * Usage: bun scripts/build-bun.ts [--target bun-darwin-arm64] [--outfile dist-bun/atlarix]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assetFiles, cliPlugin, root } from "./bun-cli-plugin";
import { windowsExeMetadata } from "./lib/windows-exe-metadata";
import { sentryDsnForBuild } from "../src/lib/sentry-gate";
// Bun 1.3.8 crashed compiled binaries natively 30-60 s into a session (a
// JavaScriptCore wasm compiler thread freeing memory twice). .bun-version pins
// the release this binary is tested on; an older Bun must not build it.
const pinned = fs.readFileSync(path.join(root, ".bun-version"), "utf8").trim();
const newer = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return true;
};
if (!newer(Bun.version, pinned)) {
  console.error(`[build-bun] FATAL: Bun ${Bun.version} is older than the pinned ${pinned}. Run \`bun upgrade\`.`);
  process.exit(1);
}
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const target = flag("--target");
const outfile = path.resolve(root, flag("--outfile") ?? "dist-bun/atlarix");
// `--outdir <dir>` writes the plain bundle instead of a binary, for inspection.
const outdir = flag("--outdir");
// `--entry <file>` compiles another entry with the same aliases (probes, tests).
const entry = path.resolve(root, flag("--entry") ?? "src/cli/entry.mts");

const version = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
).version as string;

const files = assetFiles(target);

/**
 * The libc a Linux target is built for (`bun-linux-x64-musl` → musl), or null.
 * opentui imports BOTH Linux renderers (it chooses at run time from
 * OPENTUI_LIBC), so a Linux build had to resolve the variant it never uses,
 * and CI fetches only the one it needs. Release 15.0.0's first build failed on
 * exactly that: `Could not resolve "@opentui/core-linux-x64-musl"`.
 */
const libc = target?.includes("linux") ? (target.includes("musl") ? "musl" : "glibc") : null;

/** The other libc's opentui package resolves to a stub that says so, if it is ever reached. */
function otherLibcStub(want: "musl" | "glibc"): Bun.BunPlugin {
  return {
    name: "opentui-other-libc",
    setup(b) {
      b.onResolve({ filter: /^@opentui\/core-linux-(x64|arm64)(-musl)?$/ }, (a) => {
        const isMusl = a.path.endsWith("-musl");
        if (isMusl === (want === "musl")) return undefined;
        return { path: a.path, namespace: "opentui-other-libc" };
      });
      b.onLoad({ filter: /.*/, namespace: "opentui-other-libc" }, (a) => ({
        contents: `throw new Error(${JSON.stringify(`This Atlarix build is for ${want}; ${a.path} is not included.`)});`,
        loader: "js",
      }));
    },
  };
}
for (const [key, file] of Object.entries(files)) {
  if (!fs.existsSync(file)) {
    console.error(`[build-bun] FATAL: ${key} missing at ${file}`);
    process.exit(1);
  }
}

// opentui's syntax parsing (the <markdown> and <code> renderables) runs in a
// worker it loads from a file path. In a compiled binary that path must point
// INTO the binary, so the worker is embedded and its path defined (opencode
// does the same). Without it, rendering markdown crashed the binary natively.
const TREE_SITTER_WORKER = "opentui-tree-sitter-worker.js";
// ("darwin" contains "win": match the platform exactly, not a substring.)
const targetsWindows = target ? target.includes("windows") : process.platform === "win32";
const bunfsRoot = targetsWindows ? "B:/~BUN/root/" : "/$bunfs/root/";
// fileURLToPath, not `.pathname`: on Windows that is "/D:/a/…", not a path
// (the v15.0.0 Windows CLI build failed with ENOENT on it).
const treeSitterWorker = await Bun.file(fileURLToPath(import.meta.resolve("@opentui/core/parser.worker"))).text();

// PUBLIC configuration only (the same keys the desktop embeds, minus billing).
// Applied at startup as defaults by src/cli/build-env.ts. Bun loads .env when
// it runs this script. NEVER add a secret key to this list: it ships inside the
// binary. (A PostHog project key is public by design, like the desktop's; it
// only sends once the user has opted in.)
const PUBLIC_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY",
  "ATLARIX_CORE_PROXY_URL",
  "ATLARIX_CORE_PROXY_FALLBACK_URL",
  "ATLARIX_CORE_MODEL_1",
  "ATLARIX_CORE_MODEL_2",
  "ATLARIX_CORE_MODEL_3",
  "ATLARIX_CORE_MODEL_4",
  "ATLARIX_CORE_MODEL_5",
  "ATLARIX_CORE_MODEL_6",
  "POSTHOG_API_KEY",
] as const;
const buildEnv: Record<string, string> = Object.fromEntries(
  PUBLIC_KEYS.map((k) => [k, process.env[k] ?? ""]),
);
// The prod DSN ships only in an explicit release build (ATLARIX_RELEASE=1);
// dev/QA CLI binaries embed none, so a local or QA crash can never reach the
// production Sentry project (0t). build-env.ts skips empty values at startup.
buildEnv["SENTRY_DSN"] = sentryDsnForBuild();
const missing = PUBLIC_KEYS.slice(0, 3).filter((k) => !buildEnv[k]);
if (missing.length) {
  console.warn(`[build-bun] WARN: ${missing.join(", ")} unset: sign-in and Core will not work in this build`);
}

const result = await Bun.build({
  entrypoints: [entry, ...(outdir ? [] : [TREE_SITTER_WORKER])],
  files: { [TREE_SITTER_WORKER]: treeSitterWorker },
  conditions: ["bun", "node"],
  ...(outdir
    ? { outdir: path.resolve(outdir), target: "bun" as const }
    : {
        compile: {
          outfile,
          ...(target ? { target: target as Bun.Build.Target } : {}),
          // Atlarix's name, publisher, version and icon in the exe, not Bun's
          // ("Bun" / "Oven" in SmartScreen and Task Manager: QA E6).
          ...(targetsWindows ? { windows: windowsExeMetadata(version, root) } : {}),
          // The binary runs in whatever folder the user opens, often a clone
          // they have not read yet. Left on (Bun's default), it would run that
          // folder's bunfig.toml `preload` (its code, with the user's keys and
          // session at hand, before any prompt) and load its .env into the
          // agent's own environment (HTTPS_PROXY, NODE_EXTRA_CA_CERTS,
          // ATLARIX_*). A Bun project with a preload also could not open the CLI
          // at all. Atlarix reads its own config; the workspace's is data.
          autoloadBunfig: false,
          autoloadDotenv: false,
          autoloadTsconfig: false,
          autoloadPackageJson: false,
        } as Bun.CompileBuildOptions & Record<string, unknown>,
      }),
  plugins: [cliPlugin(files), ...(libc ? [otherLibcStub(libc)] : [])],
  define: {
    // A shipped binary is a production build, like the packaged desktop app:
    // React (opentui's renderer) otherwise runs its development build, with its
    // extra checks on every render.
    "process.env.NODE_ENV": JSON.stringify("production"),
    // A Linux binary is built for one libc. opentui picks its native renderer
    // from this at run time; fixing it here makes a musl binary (Alpine) load
    // the musl renderer instead of the glibc one, which would fail to load.
    ...(libc ? { "process.env.OPENTUI_LIBC": JSON.stringify(libc) } : {}),
    __ATLARIX_HEADLESS_VERSION__: JSON.stringify(version),
    __ATLARIX_BUILD_ENV__: JSON.stringify(buildEnv),
    ...(outdir ? {} : { OTUI_TREE_SITTER_WORKER_PATH: JSON.stringify(bunfsRoot + TREE_SITTER_WORKER) }),
  },
  external: ["fsevents", "@vscode/sudo-prompt", "node-pty", "keytar"],
  minify: false,
  // A compiled binary keeps a positions-only map inside it, so a crash report's
  // frames read src/…/file.ts:line instead of the bundle's. No source text goes
  // in; the full map Bun writes beside the binary (with sources) is deleted below.
  sourcemap: outdir ? "none" : "external",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
// The binary carries its own map; the ones written beside it (the binary's and
// the tree-sitter worker's) hold the full source and must never ship.
if (!outdir) {
  const dir = path.dirname(outfile);
  for (const f of fs.readdirSync(dir)) if (f.endsWith(".map")) fs.rmSync(path.join(dir, f), { force: true });
}
console.log(`[build-bun] wrote ${outdir ?? path.relative(root, outfile)} (${version})`);

/**
 * A local macOS build is signed like the release one (Developer ID, identifier
 * "atlarix", team id), when that identity is in this Mac's keychain. Ad-hoc
 * signed ("a.out"), every rebuild was a new app to the keychain, and macOS
 * asked for the login password to read Atlarix's saved sign-in after each
 * build (owner). Signed the same way each time, one "Always Allow" covers every
 * build, released ones included. Skipped for other targets, in CI (the release
 * job signs and notarizes), and with ATLARIX_DEV_SIGN=0.
 */
if (
  process.platform === "darwin" &&
  !outdir &&
  (!target || target.includes("darwin")) &&
  !process.env.CI &&
  process.env.ATLARIX_DEV_SIGN !== "0"
) {
  const { spawnSync } = await import("node:child_process");
  const ids = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" }).stdout ?? "";
  const identity = /"(Developer ID Application:[^"]+)"/.exec(ids)?.[1];
  if (identity) {
    const r = spawnSync(
      "codesign",
      ["--force", "--options", "runtime", "--identifier", "atlarix", "--entitlements", path.join(root, "packaging/macos/cli-entitlements.plist"), "--sign", identity, outfile],
      { encoding: "utf8" },
    );
    if (r.status === 0) console.log(`[build-bun] signed as atlarix (${identity.replace(/^.*\((\w+)\)$/, "$1")})`);
    else console.warn(`[build-bun] couldn't sign (left ad-hoc): ${(r.stderr || "").trim().split("\n").at(-1)}`);
  }
}
