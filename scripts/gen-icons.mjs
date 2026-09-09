#!/usr/bin/env node
/**
 * Regenerate every derived app icon from ONE source: `assets/icon/logo.icns`.
 *
 * WHY THIS EXISTS: the rebrand from the upstream fork updated `logo.icns` but
 * left `logo.ico` carrying the OLD project's logo, so every Windows build shipped
 * the wrong brand — on the installed app (electron-packager resolves
 * `packagerConfig.icon` to `.ico` on Windows) AND on the Squirrel installer
 * (`setupIcon`). `logo.png` and `logo.iconset/` had drifted too: both were a
 * letterboxed, vertically-stretched crop rather than the clean square in the
 * `.icns`. macOS looked right, which is precisely why none of it was noticed.
 *
 * The fix is structural, not a one-off re-export: the `.icns` is the source of
 * truth (it is the variant already verified on macOS), and every other icon file
 * is a DERIVED artifact of it. Hand-editing any output re-opens the drift.
 *
 * Outputs (all COMMITTED — packaging runs on CI runners with no image tooling):
 *   assets/icon/logo.iconset/   macOS iconset, kept in sync so it stops being a trap
 *   assets/icon/logo.png        square 1024² — Linux packager icon + AppImage
 *   assets/icon/logo.ico        7 PNG frames — Windows app icon + Squirrel setupIcon
 *   build/msix/assets/*.png     Microsoft Store package logos (square, exact sizes)
 *
 * Re-run on macOS (`iconutil`/`sips` are macOS-only) whenever the brand changes.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TAG = "gen-icons";
const ROOT = process.cwd();

const ICNS = path.join(ROOT, "assets", "icon", "logo.icns");
const ICONSET_DIR = path.join(ROOT, "assets", "icon", "logo.iconset");
const PNG_OUT = path.join(ROOT, "assets", "icon", "logo.png");
const ICO_OUT = path.join(ROOT, "assets", "icon", "logo.ico");
const MSIX_DIR = path.join(ROOT, "build", "msix", "assets");

/** The conventional Windows icon ladder: shell small icons through jumbo. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** Names and sizes referenced by `build/msix/AppxManifest.template.xml`. */
const MSIX_TARGETS = [
  { name: "StoreLogo.png", size: 50 },
  { name: "Square44x44Logo.png", size: 44 },
  { name: "Square150x150Logo.png", size: 150 },
];

/** Read width/height from a PNG's IHDR, so we verify output instead of trusting sips. */
function readPngSize(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(24);
    fs.readSync(fd, buf, 0, 24, 0);
    if (buf.toString("ascii", 1, 4) !== "PNG")
      throw new Error(`${file} is not a PNG`);
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } finally {
    fs.closeSync(fd);
  }
}

/** Resize `src` to exactly size×size at `dest`, then assert the result. */
function resize(src, dest, size) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // `-z height width` forces exact dimensions. `--resampleHeightWidth` preserves
  // aspect and can land a pixel off, which MSIX rejects outright.
  execFileSync(
    "sips",
    [
      "-s",
      "format",
      "png",
      "-z",
      String(size),
      String(size),
      src,
      "--out",
      dest,
    ],
    {
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  const got = readPngSize(dest);
  if (got.width !== size || got.height !== size) {
    throw new Error(
      `${path.basename(dest)}: expected ${size}x${size}, got ${got.width}x${got.height}`,
    );
  }
  return got;
}

/**
 * Pack PNG buffers into an ICO container: ICONDIR (6 bytes) + one ICONDIRENTRY
 * (16 bytes) per frame + the frame payloads.
 *
 * Frames stay PNG-compressed rather than BMP — Windows has read PNG frames from
 * ICO containers since Vista, and it is what `png-to-ico` and the rest of the
 * Electron tooling emit, so there is no BMP row-padding or AND-mask to get wrong.
 * A 256px frame stores its dimension as 0: the field is one byte and cannot hold
 * 256, and 0 is the documented escape.
 */
function buildIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(frames.length, 4);

  const directory = Buffer.alloc(frames.length * 16);
  let offset = header.length + directory.length;

  frames.forEach((frame, i) => {
    const o = i * 16;
    const dim = frame.size >= 256 ? 0 : frame.size;
    directory.writeUInt8(dim, o + 0); // width
    directory.writeUInt8(dim, o + 1); // height
    directory.writeUInt8(0, o + 2); // palette entries (0 = no palette)
    directory.writeUInt8(0, o + 3); // reserved
    directory.writeUInt16LE(1, o + 4); // color planes
    directory.writeUInt16LE(32, o + 6); // bits per pixel
    directory.writeUInt32LE(frame.data.length, o + 8);
    directory.writeUInt32LE(offset, o + 12);
    offset += frame.data.length;
  });

  return Buffer.concat([header, directory, ...frames.map((f) => f.data)]);
}

if (process.platform !== "darwin") {
  console.error(
    `[${TAG}] needs \`iconutil\`/\`sips\` (macOS only). Every output is committed, so no ` +
      `other platform has to run this.`,
  );
  process.exit(1);
}
if (!fs.existsSync(ICNS)) {
  console.error(`[${TAG}] source missing: ${ICNS}`);
  process.exit(1);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-icons-"));
try {
  // ── Extract the source of truth ────────────────────────────────────────────
  const extracted = path.join(tmpDir, "source.iconset");
  execFileSync("iconutil", ["-c", "iconset", ICNS, "-o", extracted], {
    stdio: "inherit",
  });
  const master = path.join(extracted, "icon_512x512@2x.png");
  if (!fs.existsSync(master)) {
    throw new Error(
      `${ICNS} has no 1024x1024 (icon_512x512@2x) representation`,
    );
  }
  const src = readPngSize(master);
  if (src.width !== src.height) {
    throw new Error(`source must be square; got ${src.width}x${src.height}`);
  }
  console.log(
    `[${TAG}] source ${path.relative(ROOT, ICNS)} → master ${src.width}x${src.height}`,
  );

  // ── macOS iconset (re-synced so the folder can't drift from the .icns) ─────
  fs.rmSync(ICONSET_DIR, { recursive: true, force: true });
  fs.mkdirSync(ICONSET_DIR, { recursive: true });
  for (const entry of fs.readdirSync(extracted)) {
    fs.copyFileSync(path.join(extracted, entry), path.join(ICONSET_DIR, entry));
  }
  console.log(
    `[${TAG}] iconset: ${fs.readdirSync(ICONSET_DIR).length} file(s) re-synced`,
  );

  // ── Linux / packager PNG ──────────────────────────────────────────────────
  const png = resize(master, PNG_OUT, 1024);
  console.log(`[${TAG}] logo.png ${png.width}x${png.height}`);

  // ── Windows ICO ───────────────────────────────────────────────────────────
  const frames = ICO_SIZES.map((size) => {
    const frame = path.join(tmpDir, `ico-${size}.png`);
    resize(master, frame, size);
    return { size, data: fs.readFileSync(frame) };
  });
  const ico = buildIco(frames);
  fs.writeFileSync(ICO_OUT, ico);
  console.log(
    `[${TAG}] logo.ico ${frames.length} frames (${ICO_SIZES.join(", ")}), ${ico.length} bytes`,
  );

  // ── MSIX package logos ────────────────────────────────────────────────────
  for (const { name, size } of MSIX_TARGETS) {
    const got = resize(master, path.join(MSIX_DIR, name), size);
    console.log(`[${TAG}] msix/${name} ${got.width}x${got.height}`);
  }

  console.log(
    `[${TAG}] done — all icons derived from ${path.relative(ROOT, ICNS)}`,
  );
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
