/**
 * Resolve the platform-specific @oxc-parser/binding-* package for Electron packaging.
 * Must match oxc-parser's bindings.js optional dependency names.
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

export function isLinuxMusl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    return readFileSync("/usr/bin/ldd", "utf-8").includes("musl");
  } catch {
    try {
      return execSync("ldd --version", { encoding: "utf8" }).includes("musl");
    } catch {
      return false;
    }
  }
}

/**
 * npm package name for the native binding on this platform/arch (or null if unsupported).
 */
export function getOxcBindingPackageName(
  platform: NodeJS.Platform,
  arch: string,
  musl: boolean = isLinuxMusl(),
): string | null {
  if (platform === "darwin") {
    if (arch === "x64") return "@oxc-parser/binding-darwin-x64";
    if (arch === "arm64") return "@oxc-parser/binding-darwin-arm64";
    return null;
  }
  if (platform === "win32") {
    if (arch === "x64") return "@oxc-parser/binding-win32-x64-msvc";
    if (arch === "arm64") return "@oxc-parser/binding-win32-arm64-msvc";
    if (arch === "ia32") return "@oxc-parser/binding-win32-ia32-msvc";
    return null;
  }
  if (platform === "linux") {
    if (arch === "x64") {
      return musl
        ? "@oxc-parser/binding-linux-x64-musl"
        : "@oxc-parser/binding-linux-x64-gnu";
    }
    if (arch === "arm64") {
      return musl
        ? "@oxc-parser/binding-linux-arm64-musl"
        : "@oxc-parser/binding-linux-arm64-gnu";
    }
    if (arch === "arm") return "@oxc-parser/binding-linux-arm-gnueabihf";
    if (arch === "riscv64") {
      return musl
        ? "@oxc-parser/binding-linux-riscv64-musl"
        : "@oxc-parser/binding-linux-riscv64-gnu";
    }
    if (arch === "ppc64") return "@oxc-parser/binding-linux-ppc64-gnu";
    if (arch === "s390x") return "@oxc-parser/binding-linux-s390x-gnu";
    return null;
  }
  if (platform === "freebsd") {
    if (arch === "x64") return "@oxc-parser/binding-freebsd-x64";
    if (arch === "arm64") return "@oxc-parser/binding-freebsd-arm64";
    return null;
  }
  if (platform === "android") {
    if (arch === "arm64") return "@oxc-parser/binding-android-arm64";
    if (arch === "arm") return "@oxc-parser/binding-android-arm-eabi";
    return null;
  }
  return null;
}
