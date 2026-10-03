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
  "ATLARIX_CORE_MODEL_1",
  "ATLARIX_CORE_MODEL_2",
  "ATLARIX_CORE_MODEL_3",
  "ATLARIX_CORE_MODEL_4",
  "POSTHOG_API_KEY",
] as const;
const buildEnv = Object.fromEntries(PUBLIC_KEYS.map((k) => [k, process.env[k] ?? ""]));
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
        },
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
  sourcemap: "none",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`[build-bun] wrote ${outdir ?? path.relative(root, outfile)} (${version})`);
