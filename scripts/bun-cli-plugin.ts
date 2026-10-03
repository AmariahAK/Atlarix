/**
 * The resolution rules every Bun-run piece of the CLI shares: the compiled
 * binary (scripts/build-bun.ts) and `bun test tests-bun` (tests-bun/preload.ts).
 *
 *  - `electron` / `@sentry/electron/main` → the headless stubs, as in the
 *    esbuild build.
 *  - `better-sqlite3` → src/db/bun-sqlite-compat.ts (a native Node addon cannot
 *    load under Bun).
 *  - `tiktoken/lite` → src/runtime/tiktoken-lite-bun.ts (the package finds its
 *    wasm through `__dirname`, which a compiled binary freezes to the build
 *    machine's path).
 *  - `@/…` → src/…, Vite-style `?raw` imports → the file's text.
 *  - `atlarix:assets` → the files the CLI carries (see assetFiles()).
 */
import fs from "node:fs";
import path from "node:path";

export const root = path.resolve(import.meta.dir, "..");

const aliases: Record<string, string> = {
  electron: path.join(root, "src/headless/electron-stub.ts"),
  "@sentry/electron/main": path.join(root, "src/headless/sentry-stub.ts"),
  "better-sqlite3": path.join(root, "src/db/bun-sqlite-compat.ts"),
  "tiktoken/lite": path.join(root, "src/runtime/tiktoken-lite-bun.ts"),
};

function hasDefaultExport(file: string): boolean {
  return /^export default\b|export \{[^}]*\bdefault\b/m.test(fs.readFileSync(file, "utf8"));
}

/** ripgrep for a Bun target (default: this machine). Its package must be installed. */
export function ripgrepFor(target?: string): string {
  const [tOs, tArch] = (target ?? `bun-${process.platform}-${process.arch}`)
    .replace(/^bun-/, "")
    .split("-");
  const rgOs = tOs === "windows" ? "win32" : tOs;
  return path.join(
    root,
    `node_modules/@vscode/ripgrep-${rgOs}-${tArch}/bin/${rgOs === "win32" ? "rg.exe" : "rg"}`,
  );
}

/** The files the CLI carries, by `atlarix:assets` key. */
export function assetFiles(target?: string): Record<string, string> {
  return {
    agentsMd: path.join(root, "AGENTS.md"),
    modelsSnapshot: path.join(root, "build/models-snapshot.json.gz"),
    tiktokenWasm: path.join(root, "node_modules/tiktoken/lite/tiktoken_bg.wasm"),
    // CI and cross builds unpack the target's ripgrep package elsewhere
    // (`npm pack @vscode/ripgrep-<os>-<arch>`) and point here.
    rg: process.env.ATLARIX_RG_PATH || ripgrepFor(target),
    ...relayFor(target),
  };
}

/**
 * The Chrome bridge relay (native/atlarix-bridge), when it is built for this
 * target. Only this machine's build exists locally (`cargo build --release`);
 * cross-target relays come with the release matrix. Without one the CLI still
 * shares a browser through the desktop app's install (bridge-lifecycle.ts).
 */
function relayFor(target?: string): { relay?: string } {
  // CI: each release leg builds its own target's relay and points here
  // (release.yml build-cli), including the musl and cross-arch ones.
  const override = process.env.ATLARIX_RELAY_PATH;
  if (override) {
    if (!fs.existsSync(override)) throw new Error(`ATLARIX_RELAY_PATH does not exist: ${override}`);
    return { relay: override };
  }
  const host = `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  if (target && target !== host) return {};
  const file = path.join(
    root,
    "native/atlarix-bridge/target/release",
    process.platform === "win32" ? "atlarix-bridge.exe" : "atlarix-bridge",
  );
  return fs.existsSync(file) ? { relay: file } : {};
}

/**
 * Each file is imported `with { type: "file" }`: in a compiled binary that
 * embeds it and yields its path inside the binary; under plain `bun` it yields
 * the path on disk.
 */
export function assetsModuleSource(files: Record<string, string>, runtime = false): string {
  // Under plain `bun` (tests, probes) the files are on disk already, and a
  // virtual module's `type: "file"` import is not honoured there anyway.
  if (runtime) return `export const assets = ${JSON.stringify(files)};\n`;
  return (
    Object.entries(files)
      .map(([k, f]) => `import ${k} from ${JSON.stringify(f)} with { type: "file" };`)
      .join("\n") + `\nexport const assets = { ${Object.keys(files).join(", ")} };\n`
  );
}

/**
 * `runtime: true` for `Bun.plugin` (bun test). The runtime loader cannot serve
 * a custom namespace the way the bundler does, so there `?raw` files are loaded
 * through the file namespace by extension. Only `.sql` is imported `?raw` in
 * the CLI's graph (the embedded migrations).
 */
export function cliPlugin(
  files: Record<string, string> = assetFiles(),
  { runtime = false }: { runtime?: boolean } = {},
): Bun.BunPlugin {
  const assetsModule = assetsModuleSource(files, runtime);
  return {
    name: "atlarix-cli",
    setup(b) {
      if (runtime) {
        // The runtime loader does not consult onResolve for bare package names
        // it can already find in node_modules; a virtual module wins instead.
        for (const [name, target] of Object.entries(aliases)) {
          b.module(name, () => ({
            contents:
              `export * from ${JSON.stringify(target)};\n` +
              (hasDefaultExport(target)
                ? `export { default } from ${JSON.stringify(target)};\n`
                : ""),
            loader: "js",
          }));
        }
      } else {
        b.onResolve(
          { filter: /^(electron|@sentry\/electron\/main|better-sqlite3|tiktoken\/lite)$/ },
          (a) => ({ path: aliases[a.path]! }),
        );
      }
      // The compiled build resolves `@/…` through tsconfig.json's paths, so ONE
      // resolver names every file. Resolving it here as well gave Windows two
      // spellings of the same file (this path.join vs Bun's own for relative
      // imports), so Bun bundled src/db twice: the copy the runner initialized
      // and the copy the chat handler read ("Database not initialized", the
      // v15.0.0 Windows smoke test). `bun test` (runtime) still needs it.
      if (runtime) b.onResolve({ filter: /^@\// }, (a) => {
        const base = path.join(root, "src", a.path.slice(2));
        for (const ext of ["", ".ts", ".tsx", ".mts", "/index.ts", "/index.tsx"]) {
          if (fs.existsSync(base + ext) && fs.statSync(base + ext).isFile()) {
            return { path: base + ext };
          }
        }
        return { path: base };
      });
      if (runtime) {
        b.module("atlarix:assets", () => ({ contents: assetsModule, loader: "js" }));
      } else {
        b.onResolve({ filter: /^atlarix:assets$/ }, () => ({
          path: "atlarix-assets",
          namespace: "atlarix",
        }));
        b.onLoad({ filter: /.*/, namespace: "atlarix" }, () => ({
          contents: assetsModule,
          loader: "js",
        }));
      }
      const rawText = (file: string) => ({
        contents: `export default ${JSON.stringify(fs.readFileSync(file, "utf8"))};`,
        loader: "js" as const,
      });
      b.onResolve({ filter: /\?raw$/ }, (a) => {
        const clean = a.path.replace(/\?raw$/, "");
        const abs = path.isAbsolute(clean)
          ? clean
          : clean.startsWith(".")
            ? path.resolve(path.dirname(a.importer), clean)
            : require.resolve(clean, { paths: [path.dirname(a.importer)] });
        return runtime ? { path: abs } : { path: abs, namespace: "raw-file" };
      });
      if (runtime) {
        b.onLoad({ filter: /\.sql$/ }, (a) => rawText(a.path));
      } else {
        b.onLoad({ filter: /.*/, namespace: "raw-file" }, (a) => rawText(a.path));
      }
    },
  };
}
