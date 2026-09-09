/**
 * Read a native binary's architecture from its own header, with no toolchain.
 *
 * WHY THIS EXISTS: `verify-ci-package-out.mjs` asserts that every bundled native
 * helper matches the architecture the package was built for. `build-macos` is an
 * `arch: [arm64, x64]` matrix, so a helper left over from the previous arch would
 * otherwise be packaged silently, producing a DMG whose helper cannot execute —
 * and `npm run clean` only rimrafs `out` and `scaffold/node_modules`, so it will
 * not save you.
 *
 * Parsed rather than shelled out to on purpose: `lipo` exists only on macOS and
 * `dumpbin` needs a Visual Studio environment, so a shell-based check would be
 * unavailable on the very cross-checks that matter.
 */
import fs from "node:fs";

/** Mach-O magics. FAT files are big-endian regardless of host. */
const MH_MAGIC_64 = 0xfeedfacf;
const MH_CIGAM_64 = 0xcffaedfe;
const MH_MAGIC = 0xfeedface;
const MH_CIGAM = 0xcefaedfe;
const FAT_MAGIC = 0xcafebabe;
const FAT_CIGAM = 0xbebafeca;

const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

/** PE IMAGE_FILE_HEADER.Machine values. */
const PE_MACHINE = {
  0x8664: "x64",
  0x014c: "ia32",
  0xaa64: "arm64",
  0x01c4: "arm",
};

/** ELF e_machine values. */
const ELF_MACHINE = { 0x3e: "x64", 0x03: "ia32", 0xb7: "arm64", 0x28: "arm" };

function machoArch(buf) {
  const be = buf.readUInt32BE(0);
  if (be === FAT_MAGIC || be === FAT_CIGAM) {
    // A universal binary: read every slice's cputype.
    const count = buf.readUInt32BE(4);
    const archs = [];
    for (let i = 0; i < count; i++) {
      const off = 8 + i * 20;
      if (off + 4 > buf.length) break;
      const cpu = buf.readUInt32BE(off);
      if (cpu === CPU_TYPE_ARM64) archs.push("arm64");
      else if (cpu === CPU_TYPE_X86_64) archs.push("x64");
      else archs.push(`cpu:0x${cpu.toString(16)}`);
    }
    return archs;
  }
  const le = buf.readUInt32LE(0);
  const isMacho =
    [MH_MAGIC_64, MH_CIGAM_64, MH_MAGIC, MH_CIGAM].includes(le) ||
    [MH_MAGIC_64, MH_CIGAM_64, MH_MAGIC, MH_CIGAM].includes(be);
  if (!isMacho) return null;
  // cputype is the second word, in the file's own endianness.
  const little = le === MH_MAGIC_64 || le === MH_MAGIC;
  const cpu = little ? buf.readUInt32LE(4) : buf.readUInt32BE(4);
  if (cpu === CPU_TYPE_ARM64) return ["arm64"];
  if (cpu === CPU_TYPE_X86_64) return ["x64"];
  return [`cpu:0x${cpu.toString(16)}`];
}

function peArch(buf) {
  if (buf.readUInt16LE(0) !== 0x5a4d) return null; // "MZ"
  const peOff = buf.readUInt32LE(0x3c);
  if (peOff + 6 > buf.length) return null;
  if (buf.readUInt32LE(peOff) !== 0x00004550) return null; // "PE\0\0"
  const machine = buf.readUInt16LE(peOff + 4);
  return [PE_MACHINE[machine] ?? `machine:0x${machine.toString(16)}`];
}

function elfArch(buf) {
  if (buf.readUInt32BE(0) !== 0x7f454c46) return null; // \x7fELF
  const machine = buf.readUInt16LE(0x12);
  return [ELF_MACHINE[machine] ?? `machine:0x${machine.toString(16)}`];
}

/**
 * @param {string} file
 * @returns {string[]} node-style arch names, e.g. ["arm64"] or ["arm64","x64"]
 * @throws if the file is unreadable or not a recognised executable format
 */
export function readBinaryArchs(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(4096);
    const read = fs.readSync(fd, buf, 0, 4096, 0);
    if (read < 64)
      throw new Error(`${file}: too small to be an executable (${read} bytes)`);
    const slice = buf.subarray(0, read);
    const archs = machoArch(slice) ?? peArch(slice) ?? elfArch(slice);
    if (!archs)
      throw new Error(`${file}: not a recognised Mach-O, PE or ELF binary`);
    return archs;
  } finally {
    fs.closeSync(fd);
  }
}

/** Map a Rust target triple to the node-style arch it produces. */
export function archForTriple(triple) {
  if (triple.startsWith("aarch64-")) return "arm64";
  if (triple.startsWith("x86_64-")) return "x64";
  if (triple.startsWith("i686-")) return "ia32";
  throw new Error(`unknown target triple: ${triple}`);
}

/**
 * Throw unless `file` contains code for `expected` (a node-style arch).
 * A universal binary satisfies any arch it actually carries.
 */
export function assertBinaryArch(file, expected, tag = "binary-arch") {
  const archs = readBinaryArchs(file);
  if (!archs.includes(expected)) {
    throw new Error(
      `[${tag}] ${file} is ${archs.join("+")} but ${expected} was expected. ` +
        `A stale native/.dist/ from another arch is the usual cause — the build scripts ` +
        `delete it first, so this means something wrote it afterwards.`,
    );
  }
  return archs;
}
