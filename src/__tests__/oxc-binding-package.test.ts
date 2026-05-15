import { describe, expect, it } from "vitest";
import { getOxcBindingPackageName } from "../lib/blueprint/rte/parsers/oxc-binding-package";

describe("getOxcBindingPackageName", () => {
  it("maps darwin arm64 and x64", () => {
    expect(getOxcBindingPackageName("darwin", "arm64", false)).toBe(
      "@oxc-parser/binding-darwin-arm64",
    );
    expect(getOxcBindingPackageName("darwin", "x64", false)).toBe(
      "@oxc-parser/binding-darwin-x64",
    );
  });

  it("maps win32 x64 and arm64", () => {
    expect(getOxcBindingPackageName("win32", "x64", false)).toBe(
      "@oxc-parser/binding-win32-x64-msvc",
    );
    expect(getOxcBindingPackageName("win32", "arm64", false)).toBe(
      "@oxc-parser/binding-win32-arm64-msvc",
    );
  });

  it("maps linux x64 gnu vs musl", () => {
    expect(getOxcBindingPackageName("linux", "x64", false)).toBe(
      "@oxc-parser/binding-linux-x64-gnu",
    );
    expect(getOxcBindingPackageName("linux", "x64", true)).toBe(
      "@oxc-parser/binding-linux-x64-musl",
    );
  });

  it("returns null for unsupported platform", () => {
    expect(getOxcBindingPackageName("aix" as NodeJS.Platform, "x64", false)).toBeNull();
  });
});
