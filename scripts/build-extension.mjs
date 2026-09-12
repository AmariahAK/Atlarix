#!/usr/bin/env node
/**
 * Build the Chrome MV3 extension: an unpacked directory to load during
 * development, and a zip to upload to the Chrome Web Store.
 *
 * Output:
 *   packages/extension/dist/unpacked/                 ← load this in chrome://extensions
 *   packages/extension/dist/atlarix-extension-<v>.zip ← upload this
 *
 * WHY THIS IS NOT `npm run build:headless` WITH DIFFERENT FLAGS. That bundle
 * targets Node and shims `require`/`__dirname` into existence. This one must
 * produce code for a browser sandbox where those names are not merely absent
 * but a sign that something Node-shaped has leaked into a bundle that cannot
 * run it — hence `platform: "browser"` and the resolve plugin below, which
 * turns that leak into a named build error instead of a runtime one.
 *
 * The page-realm scripts are IMPORTED from `src/lib/browser/` through the `@`
 * alias, never copied. A second copy of the walker is a second contract, and
 * the model was promised one.
 */
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const TAG = "build-extension";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = path.join(root, "packages/extension");
const outDir = path.join(pkgDir, "dist");
const unpackedDir = path.join(outDir, "unpacked");

/** `--allow-missing-config` builds the shell without Supabase credentials. */
const allowMissingConfig = process.argv.includes("--allow-missing-config");

function fatal(message) {
  console.error(`[${TAG}] FATAL: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Version: one truth, checked
// ---------------------------------------------------------------------------

// The version lives in BOTH manifest.json (where Chrome reads it) and
// package.json (where the zip filename and the `define` read it). Neither can
// be dropped — a manifest without `version` is invalid, and a package without
// one breaks the sibling-package convention. So assert they agree rather than
// letting a release ship a zip whose name disagrees with its contents.
const manifestPath = path.join(pkgDir, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const pkg = JSON.parse(
  fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"),
);
if (manifest.version !== pkg.version) {
  fatal(
    `version mismatch — manifest.json says ${manifest.version}, ` +
      `packages/extension/package.json says ${pkg.version}`,
  );
}
const version = manifest.version;

// `target` and `minimum_chrome_version` must not drift: esbuild downlevelling
// to an older syntax than Chrome requires is harmless, but the reverse ships
// syntax the manifest claims to support and the browser rejects at parse time.
const minChrome = String(manifest.minimum_chrome_version ?? "").trim();
if (!/^\d+$/.test(minChrome)) {
  fatal(
    `manifest.minimum_chrome_version must be a plain number, got ${minChrome}`,
  );
}

// ---------------------------------------------------------------------------
// Build-time configuration
// ---------------------------------------------------------------------------

// Same env names `vite.main.config.mts` reads, so one `.env` serves the app and
// the extension and CI needs no new secret.
try {
  const { createRequire } = await import("node:module");
  createRequire(import.meta.url)("dotenv").config();
} catch {
  // dotenv optional — CI supplies these as real environment variables.
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY ?? "";

// Never `?? ""` into the bundle. An extension built with an empty Supabase URL
// installs and opens fine, then fails at sign-in with a bare fetch error ten
// steps downstream of the actual mistake. Fail here, where the cause is legible.
if (!allowMissingConfig && (!supabaseUrl || !supabaseAnonKey)) {
  fatal(
    "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY " +
      "must be set (see .env.example). Pass --allow-missing-config to build the " +
      "shell without them.",
  );
}

// ---------------------------------------------------------------------------
// The resolve guard
// ---------------------------------------------------------------------------

/**
 * `packages/extension/tsconfig.json` sets `types: []` so a Node builtin does
 * not TYPE-check. That stops the obvious case and misses two: a transitive
 * import through a shared module under `src/`, and a bare `path`/`crypto`
 * specifier that would resolve to a node_modules shim instead. This turns both
 * into a build error that names the importer.
 */
const NODE_BUILTINS =
  /^(node:|assert$|buffer$|child_process$|crypto$|events$|fs$|http$|https$|module$|net$|os$|path$|process$|stream$|url$|util$|zlib$)/;
const noNodeBuiltinsPlugin = {
  name: "no-node-builtins",
  setup(b) {
    b.onResolve({ filter: NODE_BUILTINS }, (args) => ({
      errors: [
        {
          text: `"${args.path}" is a Node builtin and cannot exist in an extension bundle`,
          notes: [
            { text: `imported from ${args.importer}` },
            {
              text:
                "The extension runs in a browser sandbox. If this arrived through a " +
                "shared module under src/, that module is not portable — see " +
                "src/__tests__/page-scripts-portable.test.ts for the rule.",
            },
          ],
        },
      ],
    }));
  },
};

// ---------------------------------------------------------------------------
// Bundle
// ---------------------------------------------------------------------------

// A renamed entry point otherwise leaves its old output behind, and the zip
// packs whatever is in the directory.
fs.rmSync(unpackedDir, { recursive: true, force: true });
fs.mkdirSync(path.join(unpackedDir, "icons"), { recursive: true });

const result = await build({
  entryPoints: {
    background: path.join(pkgDir, "src/background/service-worker.ts"),
    sidepanel: path.join(pkgDir, "src/panel/sidepanel.ts"),
  },
  outdir: unpackedDir,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: [`chrome${minChrome}`],
  // One self-contained file per entry. A shared chunk buys nothing at this size
  // and gives the module service worker another file to resolve at startup.
  splitting: false,
  // NOT an oversight. Chrome Web Store review reads the source, and a minified
  // bundle draws a "please supply un-minified code" round trip measured in days
  // — on an extension that will already attract scrutiny for `debugger` and
  // broad host access. Size is not a constraint here; review latency is.
  minify: false,
  sourcemap: false,
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
  alias: { "@": path.join(root, "src") },
  define: {
    __ATLARIX_SUPABASE_URL__: JSON.stringify(supabaseUrl),
    __ATLARIX_SUPABASE_ANON_KEY__: JSON.stringify(supabaseAnonKey),
    __ATLARIX_EXTENSION_VERSION__: JSON.stringify(version),
  },
  plugins: [noNodeBuiltinsPlugin],
});

for (const [file, meta] of Object.entries(result.metafile.outputs)) {
  console.log(
    `[${TAG}] bundled ${path.basename(file)} (${(meta.bytes / 1024).toFixed(1)} KB)`,
  );
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/** Width/height from a PNG's IHDR — verify the asset instead of trusting its name. */
function readPngSize(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(24);
    fs.readSync(fd, buf, 0, 24, 0);
    if (buf.toString("ascii", 1, 4) !== "PNG") {
      throw new Error(`${file} is not a PNG`);
    }
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } finally {
    fs.closeSync(fd);
  }
}

const iconset = (name) => path.join(root, "assets/icon/logo.iconset", name);

// Icons are copied from the iconset at build time rather than committed into
// the package. `assets/icon/logo.icns` stays the single source of truth for the
// brand (see scripts/gen-icons.mjs — "hand-editing any output re-opens the
// drift"), and this build gains no derived files to keep in sync.
//
// MV3 accepts arbitrary icon sizes and downscales, so the absence of a 48x48
// anywhere in the repo is not a blocker and is not a reason to touch gen-icons.
const ASSETS = [
  { src: manifestPath, dest: "manifest.json" },
  {
    src: path.join(pkgDir, "src/panel/sidepanel.html"),
    dest: "sidepanel.html",
  },
  { src: path.join(pkgDir, "src/panel/sidepanel.css"), dest: "sidepanel.css" },
  { src: iconset("icon_16x16.png"), dest: "icons/16.png", px: 16 },
  { src: iconset("icon_32x32.png"), dest: "icons/32.png", px: 32 },
  { src: iconset("icon_128x128.png"), dest: "icons/128.png", px: 128 },
];

// Every asset is required. A missing icon is not a soft degrade — Chrome
// refuses to load a manifest that references a file which is not there.
for (const { src, dest, px } of ASSETS) {
  if (!fs.existsSync(src)) {
    fatal(`required asset ${src} not found — the manifest references ${dest}`);
  }
  if (px !== undefined) {
    const { width, height } = readPngSize(src);
    if (width !== px || height !== px) {
      fatal(
        `${src} is ${width}x${height}, expected ${px}x${px} — the iconset ` +
          `naming has changed and ${dest} no longer means what it says`,
      );
    }
  }
  fs.copyFileSync(src, path.join(unpackedDir, dest));
  console.log(`[${TAG}] copied ${dest}${px ? ` (${px}x${px})` : ""}`);
}

// ---------------------------------------------------------------------------
// The zip
// ---------------------------------------------------------------------------

// Hand-rolled rather than `execFileSync("zip")`: this repo's CI runs
// windows-latest, which has no `zip` on PATH, and `buildIco` in
// scripts/gen-icons.mjs already establishes the house pattern of writing a
// binary container directly with byte-level comments.

/** CRC-32 (IEEE 802.3), the checksum every zip entry carries. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Every file under `dir`, as zip-relative forward-slashed paths. */
function walk(dir, prefix = "") {
  const out = [];
  for (const entry of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(abs, rel));
    else out.push({ name: rel, data: fs.readFileSync(abs) });
  }
  return out;
}

/**
 * A store-and-deflate zip with no directory entries and a fixed timestamp.
 *
 * The fixed 1980-01-01 stamp makes the archive REPRODUCIBLE: the same sources
 * produce byte-identical bytes, so "did the artifact actually change" is a
 * checksum rather than a guess. Sizes are known before writing, so no entry
 * needs a data descriptor.
 */
function makeZip(files) {
  const DOS_TIME = 0x0000; // 00:00:00
  const DOS_DATE = 0x0021; // 1980-01-01
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed (2.0 — deflate)
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    nameBuf.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(8, 10); // method: deflate
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralBuf, eocd]);
}

const files = walk(unpackedDir);
// manifest.json must sit at the ROOT of the archive, not under a folder — the
// commonest way a first Web Store upload is rejected.
if (!files.some((f) => f.name === "manifest.json")) {
  fatal("manifest.json is not at the zip root");
}
const zipPath = path.join(outDir, `atlarix-extension-${version}.zip`);
const zip = makeZip(files);
fs.writeFileSync(zipPath, zip);

console.log(
  `[${TAG}] wrote ${path.relative(root, unpackedDir)} (${files.length} files)`,
);
console.log(
  `[${TAG}] wrote ${path.relative(root, zipPath)} ` +
    `(${(zip.length / 1024).toFixed(1)} KB, ${files.length} entries)`,
);
console.log(`[${TAG}] load unpacked: ${path.relative(root, unpackedDir)}`);
