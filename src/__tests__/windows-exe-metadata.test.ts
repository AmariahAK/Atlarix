/**
 * QA E6: atlarix.exe carried Bun's version resource ("Bun" / "Oven" in
 * SmartScreen and Task Manager). We cannot run a Windows build here, so this
 * checks what the build passes Bun, and that the build passes it.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { windowsExeMetadata, windowsFileVersion } from "../../scripts/lib/windows-exe-metadata";

const root = path.resolve(__dirname, "../..");

describe("the Windows exe's metadata", () => {
  it("is Atlarix's: name, publisher (as the MSIX shows it), description, icon", () => {
    const m = windowsExeMetadata("15.11.0", root);
    expect(m).toMatchObject({ title: "Atlarix", publisher: "Amariah Abishai", version: "15.11.0.0", description: "Atlarix CLI" });
    expect(fs.existsSync(m.icon)).toBe(true);
    const msix = fs.readFileSync(path.join(root, "build/msix/AppxManifest.template.xml"), "utf8");
    expect(msix).toContain(`<PublisherDisplayName>${m.publisher}</PublisherDisplayName>`);
  });

  it("the version is always four numbers, as Windows needs", () => {
    expect(windowsFileVersion("15.11.0")).toBe("15.11.0.0");
    expect(windowsFileVersion("15.11.0-beta.2")).toBe("15.11.0.2");
    expect(windowsFileVersion("15")).toBe("15.0.0.0");
  });

  it("build-bun.ts passes it for Windows targets, and only those", () => {
    const src = fs.readFileSync(path.join(root, "scripts/build-bun.ts"), "utf8");
    expect(src).toMatch(/targetsWindows \? \{ windows: windowsExeMetadata\(version, root\) \} : \{\}/);
  });
});
