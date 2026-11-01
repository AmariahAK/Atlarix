/**
 * The per-file Team ID scan (scripts/mac-team-id.mjs). `codesign --verify
 * --deep` passed a bundle with ad-hoc and unsigned dylibs and .node files
 * (2026-10-30); the scan must find every Mach-O and name each one that is off.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — a plain .mjs build script with no type declarations.
import { isMachO, listMachO, parseCodesignDisplay, scanTeamIds } from "../../scripts/mac-team-id.mjs";

const MACHO64 = Buffer.from("cffaedfe07000001", "hex");
const FAT = Buffer.from("cafebabe00000002", "hex");
let root = "";

function app() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "teamid-"));
  const put = (rel: string, bytes: Buffer | string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), bytes);
  };
  put("Contents/MacOS/Atlarix", MACHO64);
  put("Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib", FAT);
  put("Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node", MACHO64);
  put("Contents/Resources/app.asar.unpacked/node_modules/@lydell/node-pty-darwin-arm64/spawn-helper", MACHO64);
  put("Contents/Resources/app.asar", "not a binary");
  put("Contents/Info.plist", "<plist/>");
  fs.symlinkSync(
    "Versions/A/Libraries",
    path.join(root, "Contents/Frameworks/Electron Framework.framework/Libraries"),
  );
  return root;
}

const signed = (team: string) =>
  `Executable=/x\nIdentifier=x\nAuthority=Developer ID Application: Someone (${team})\nTeamIdentifier=${team}\n`;

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe("the Mac Team ID scan", () => {
  it("finds every Mach-O (thin and fat), skips other files, never follows symlinks", () => {
    expect(isMachO(MACHO64)).toBe(true);
    expect(isMachO(Buffer.from("PK\u0003\u0004"))).toBe(false);
    const found = listMachO(app()).map((f: string) => path.relative(root, f)).sort();
    expect(found).toEqual([
      "Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib",
      "Contents/MacOS/Atlarix",
      "Contents/Resources/app.asar.unpacked/node_modules/@lydell/node-pty-darwin-arm64/spawn-helper",
      "Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
    ]);
  });

  it("reads what signed a file: our team, another team, ad-hoc or nothing", () => {
    expect(parseCodesignDisplay(signed("7VWW7N9R87"))).toBe("7VWW7N9R87");
    expect(parseCodesignDisplay(signed("EQHXZ8M8AV"))).toBe("EQHXZ8M8AV");
    expect(parseCodesignDisplay("Executable=/x\nSignature=adhoc\nTeamIdentifier=not set\n")).toBe("adhoc");
    expect(parseCodesignDisplay("/x: code object is not signed at all\n")).toBe("unsigned");
    // Nothing readable is not a pass, and not a guess either.
    expect(parseCodesignDisplay("")).toBe("unknown");
  });

  it("names each file that lacks our Team ID, which --verify --deep let through", () => {
    const dir = app();
    const display = (file: string) =>
      file.endsWith("libffmpeg.dylib")
        ? "Signature=adhoc\nTeamIdentifier=not set\n"
        : file.endsWith(".node")
          ? "code object is not signed at all"
          : signed("7VWW7N9R87");
    const { checked, off } = scanTeamIds(dir, { display });
    expect(checked).toBe(4);
    expect(off).toEqual([
      { file: "Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib", signer: "adhoc" },
      { file: "Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node", signer: "unsigned" },
    ]);
  });

  it("passes a bundle signed throughout by our team", () => {
    expect(scanTeamIds(app(), { display: () => signed("7VWW7N9R87") }).off).toEqual([]);
  });
});
