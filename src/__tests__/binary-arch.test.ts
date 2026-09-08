/**
 * `scripts/binary-arch.mjs` is the guard against a real, silent packaging hazard:
 * `build-macos` is an `arch: [arm64, x64]` matrix, so a native helper left over
 * from the previous arch would be packaged without complaint, and `npm run clean`
 * only rimrafs `out` and `scaffold/node_modules`, so it would not help.
 * `verify-ci-package-out.mjs` re-asserts the arch of every bundled helper inside
 * the package it actually built.
 *
 * A guard that mis-reads a header is worse than no guard, so it is pinned here
 * against SYNTHETIC headers rather than against whatever binaries happen to be on
 * the machine — deterministic, and it runs on every platform. (It was also
 * cross-checked by hand against `lipo -archs` on a real universal binary and a real
 * arm64 one while it was written.)
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readBinaryArchs,
  archForTriple,
  assertBinaryArch,
} from "../../scripts/binary-arch.mjs";

let dir: string;
const write = (name: string, buf: Buffer) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
};

/** A 64-bit Mach-O header, little-endian, with the given cputype. */
function macho64(cpuType: number): Buffer {
  const b = Buffer.alloc(128);
  b.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64
  b.writeUInt32LE(cpuType, 4);
  return b;
}

/** A universal (fat) header. Always big-endian, whatever the host. */
function fat(cpuTypes: number[]): Buffer {
  const b = Buffer.alloc(256);
  b.writeUInt32BE(0xcafebabe, 0); // FAT_MAGIC
  b.writeUInt32BE(cpuTypes.length, 4);
  cpuTypes.forEach((cpu, i) => b.writeUInt32BE(cpu, 8 + i * 20));
  return b;
}

function pe(machine: number): Buffer {
  const b = Buffer.alloc(512);
  b.writeUInt16LE(0x5a4d, 0); // "MZ"
  b.writeUInt32LE(0x80, 0x3c); // e_lfanew
  b.writeUInt32LE(0x00004550, 0x80); // "PE\0\0"
  b.writeUInt16LE(machine, 0x84);
  return b;
}

function elf(machine: number): Buffer {
  const b = Buffer.alloc(128);
  b.writeUInt32BE(0x7f454c46, 0); // \x7fELF
  b.writeUInt16LE(machine, 0x12);
  return b;
}

const CPU_ARM64 = 0x0100000c;
const CPU_X86_64 = 0x01000007;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-arch-"));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("readBinaryArchs", () => {
  it("reads a 64-bit Mach-O", () => {
    expect(readBinaryArchs(write("m-arm", macho64(CPU_ARM64)))).toEqual(["arm64"]);
    expect(readBinaryArchs(write("m-x64", macho64(CPU_X86_64)))).toEqual(["x64"]);
  });

  it("reads every slice of a universal binary", () => {
    // The case that made the fat path worth writing: a universal binary satisfies
    // either arch, so a naive "first slice wins" reader would reject a valid file.
    expect(readBinaryArchs(write("fat", fat([CPU_X86_64, CPU_ARM64])))).toEqual([
      "x64",
      "arm64",
    ]);
  });

  it("reads a PE image", () => {
    expect(readBinaryArchs(write("w-x64.exe", pe(0x8664)))).toEqual(["x64"]);
    expect(readBinaryArchs(write("w-arm.exe", pe(0xaa64)))).toEqual(["arm64"]);
  });

  it("reads an ELF image", () => {
    expect(readBinaryArchs(write("l-x64", elf(0x3e)))).toEqual(["x64"]);
    expect(readBinaryArchs(write("l-arm", elf(0xb7)))).toEqual(["arm64"]);
  });

  it("reports an unknown machine rather than guessing", () => {
    // Silently mapping an unrecognised value to a plausible arch is how a guard
    // starts passing things it should reject.
    expect(readBinaryArchs(write("w-odd.exe", pe(0x1234)))[0]).toMatch(/^machine:0x1234$/);
  });

  it("throws on a file that is not an executable", () => {
    const p = write("text.txt", Buffer.from("#!/bin/sh\necho hi\n".repeat(8)));
    expect(() => readBinaryArchs(p)).toThrow(/not a recognised Mach-O, PE or ELF/);
  });

  it("throws on a truncated file rather than reading past the end", () => {
    const p = write("tiny", Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
    expect(() => readBinaryArchs(p)).toThrow(/too small/);
  });
});

describe("archForTriple", () => {
  it("maps the triples the build scripts use", () => {
    expect(archForTriple("aarch64-apple-darwin")).toBe("arm64");
    expect(archForTriple("x86_64-apple-darwin")).toBe("x64");
    expect(archForTriple("x86_64-pc-windows-msvc")).toBe("x64");
    expect(archForTriple("aarch64-pc-windows-msvc")).toBe("arm64");
    expect(archForTriple("x86_64-unknown-linux-gnu")).toBe("x64");
  });

  it("throws on an unknown triple", () => {
    expect(() => archForTriple("riscv64gc-unknown-linux-gnu")).toThrow(/unknown target triple/);
  });
});

describe("assertBinaryArch", () => {
  it("passes when the arch matches, and when a universal binary contains it", () => {
    expect(() => assertBinaryArch(write("ok", macho64(CPU_ARM64)), "arm64")).not.toThrow();
    expect(() =>
      assertBinaryArch(write("fat2", fat([CPU_X86_64, CPU_ARM64])), "x64"),
    ).not.toThrow();
  });

  it("throws with the stale-staging hint on a mismatch — the whole point", () => {
    const p = write("wrong", macho64(CPU_X86_64));
    expect(() => assertBinaryArch(p, "arm64", "build-cu-helper")).toThrow(
      /is x64 but arm64 was expected/,
    );
    // The message must name the likely cause; a bare mismatch sends someone
    // hunting through cargo rather than deleting native/.dist.
    expect(() => assertBinaryArch(p, "arm64")).toThrow(/stale native\/\.dist/);
  });
});
