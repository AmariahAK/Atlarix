#!/usr/bin/env node
/**
 * Bundle the headless Atlarix agent CLI into a single Node-runnable file.
 *
 * Aliases `electron` and `@sentry/electron/main` to inert headless stubs and
 * `@/` → src at BUILD time (no fragile runtime loader). Native modules stay
 * external — they're loaded from node_modules at runtime (better-sqlite3 must be
 * the Node-ABI build: `npm install --prefix tests/infra` and run with NODE_PATH
 * pointing there, or rebuild for Node).
 *
 * Output: dist-headless/atlarix-headless.mjs
 */
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The bundle carried no version string at all, so a benchmark harness asking the
// binary what it is (Harbor's `get_version_command()`, filed as `agent_version` on
// a leaderboard row) fell through to reporting the NODE version. Inject the app's.
const pkgVersion = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
).version;

/** Handle vite-style `import x from "./file.sql?raw"` (text contents). */
const rawLoaderPlugin = {
  name: "raw-loader",
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (args) => {
      const clean = args.path.replace(/\?raw$/, "");
      let abs;
      if (path.isAbsolute(clean)) {
        abs = clean;
      } else if (clean.startsWith(".")) {
        abs = path.resolve(args.resolveDir, clean);
      } else {
        // Bare specifier (e.g. "axe-core/axe.min.js") — resolve through
        // node_modules like Vite does. Previously treated as importer-relative,
        // which ENOENT'd the first bare ?raw import (v14.8.6 visual-lint axe).
        abs = createRequire(
          path.join(args.resolveDir, "resolve-anchor.js"),
        ).resolve(clean);
      }
      return { path: abs, namespace: "raw-file" };
    });
    b.onLoad({ filter: /.*/, namespace: "raw-file" }, (args) => ({
      contents: fs.readFileSync(args.path, "utf8"),
      loader: "text",
    }));
  },
};

// Native / binary / electron-only packages that must not be bundled.
const external = [
  "better-sqlite3",
  "fsevents",
  "@vscode/sudo-prompt",
  "node-pty",
  "keytar",
];

await build({
  entryPoints: [path.join(root, "src/headless/atlarix-headless.mts")],
  outfile: path.join(root, "dist-headless/atlarix-headless.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  logLevel: "info",
  external,
  define: { __ATLARIX_HEADLESS_VERSION__: JSON.stringify(pkgVersion) },
  plugins: [rawLoaderPlugin],
  alias: {
    electron: path.join(root, "src/headless/electron-stub.ts"),
    "@sentry/electron/main": path.join(root, "src/headless/sentry-stub.ts"),
    "@": path.join(root, "src"),
    // The files shipped beside the bundle (copied below).
    "atlarix:assets": path.join(root, "src/runtime/assets-node.ts"),
  },
  // ESM bundle needs require()/__dirname/__filename shimmed: deps and our own
  // code use CJS interop and `__dirname`-relative asset lookups (system prompt,
  // skills, tiktoken). In ESM these are undefined → ReferenceError at
  // module-init unless we define them. __dirname resolves to the bundle's own
  // dir (dist-headless), which is where we also ship the AGENTS*.md files.
  banner: {
    // The shebang makes the bundle directly executable, which is what the npm
    // package's `bin` entry needs — without it `atlarix` resolves to a file the
    // shell tries to run as a shell script. It must be alone on line 1, hence the
    // newline join here rather than the space join used for the interop shims
    // below. Node strips it when the file is imported.
    js: [
      "#!/usr/bin/env node",
      [
        "import { createRequire as __cr } from 'node:module';",
        "import { fileURLToPath as __fileURLToPath } from 'node:url';",
        "import { dirname as __pathDirname } from 'node:path';",
        "const require = __cr(import.meta.url);",
        "const __filename = __fileURLToPath(import.meta.url);",
        "const __dirname = __pathDirname(__filename);",
      ].join(" "),
    ].join("\n"),
  },
});

// Ship runtime assets next to the bundle so `__dirname/<file>` lookups resolve
// in headless (no Electron app/resources path): the system-prompt AGENTS files
// and tiktoken's wasm (the bundled tiktoken/lite cjs reads __dirname/tiktoken_bg.wasm
// first). wasm is arch-independent, so the host copy is fine.
const outDir = path.join(root, "dist-headless");
const assets = [
  // Single unified guidance bundle (a88cdeb consolidated AGENTS_COMPACT.md +
  // AGENTS_MODE_BASE.md → AGENTS.md). system_prompt.ts loads AGENTS.md from
  // __dirname; if it isn't shipped here the headless CLI silently falls back to
  // the 6-line FALLBACK_AGENTS stub. Keep this filename in sync with that loader.
  { src: path.join(root, "AGENTS.md"), dest: "AGENTS.md" },
  {
    src: path.join(root, "node_modules/tiktoken/lite/tiktoken_bg.wasm"),
    dest: "tiktoken_bg.wasm",
  },
  // The models.dev catalog snapshot. Headless resolved it relative to `cwd`,
  // which in a benchmark container is the TASK directory — so it was never found
  // and the catalog depended entirely on reaching models.dev over the network.
  // That is not a safe dependency where it matters most: Terminal-Bench sandboxes
  // enforce an egress allow-list (github / npm / the model endpoint), and
  // models.dev is not on it. With no catalog, per-model reasoning profiles are
  // unavailable and reasoning falls back to a provider heuristic that sends a
  // DIFFERENT wire shape — so the same command would mean different things
  // depending on whether the sandbox happened to have open egress. Shipping it
  // makes that resolution deterministic. 438KB gzipped.
  {
    src: path.join(root, "build/models-snapshot.json.gz"),
    dest: "models-snapshot.json.gz",
  },
  // The MCP marketplace catalog (src/lib/mcp/registry-catalog.ts) for runs with no
  // network or with the registry down.
  {
    src: path.join(root, "build/mcp-registry-snapshot.json.gz"),
    dest: "mcp-registry-snapshot.json.gz",
  },
];
// The mode prompts, sub-agent prompts and guides. Headless read them from
// `<cwd>/src/skills`, which in a benchmark container is the TASK directory, so
// every run went without its mode prompt and every sub-agent failed (ENOENT).
fs.cpSync(path.join(root, "src", "skills"), path.join(outDir, "skills"), { recursive: true });
console.log("[build-headless] copied skills/ next to bundle");

// AGENTS.md is load-bearing: without it headless runs on the FALLBACK_AGENTS
// stub (silent capability cliff). Fail the build loudly rather than ship a
// degraded tarball. The wasm is a soft degrade, so it stays a warning.
const REQUIRED = new Set(["AGENTS.md"]);
for (const { src, dest } of assets) {
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(outDir, dest));
    console.log(`[build-headless] copied ${dest} next to bundle`);
  } else if (REQUIRED.has(dest)) {
    console.error(
      `[build-headless] FATAL: required asset ${src} not found — headless would fall back to the stub prompt`,
    );
    process.exit(1);
  } else {
    console.warn(
      `[build-headless] WARN: ${src} not found — headless may degrade`,
    );
  }
}

console.log("[build-headless] wrote dist-headless/atlarix-headless.mjs");
