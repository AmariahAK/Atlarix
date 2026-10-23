/**
 * Guards `build/msix/AppxManifest.template.xml`.
 *
 * The manifest is hand-edited, load-bearing, and only validated by `makeappx.exe`
 * on a Windows runner — so a mistake here costs a full CI round trip to discover.
 * It has already happened once: a comment described a CLI flag as `- -self-test`
 * (written with a real double hyphen), which XML forbids inside comments. The file
 * looked perfectly fine on inspection and would have failed `makeappx pack`.
 *
 * These assertions cover what a schema check cannot: that the identity still
 * matches what Partner Center assigned, and that the declarations the app depends
 * on at RUNTIME are actually present.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { windowsRegistryKeys } from "@/lib/bridge/host-install";

const TEMPLATE = path.join(
  process.cwd(),
  "build",
  "msix",
  "AppxManifest.template.xml",
);
const raw = fs.readFileSync(TEMPLATE, "utf8");

/** Assigned by Partner Center for the reserved "Atlarix" name. Not ours to change. */
const IDENTITY_NAME = "AmariahAbishai.Atlarix";
const IDENTITY_PUBLISHER = "CN=B8A553CE-4E5B-49AD-B077-6973F43EADFD";
const PUBLISHER_DISPLAY_NAME = "Amariah Abishai";

describe("AppxManifest template — XML validity", () => {
  it("has no double hyphen inside any comment", () => {
    // `--` terminates a comment early, so XML disallows it in comment bodies.
    const comments = raw.match(/<!--[\s\S]*?-->/g) ?? [];
    expect(comments.length).toBeGreaterThan(0);
    const offenders = comments
      .map((c) => c.slice(4, -3))
      .filter((body) => body.includes("--"))
      .map((body) => body.trim().slice(0, 80));
    expect(offenders).toEqual([]);
  });

  it("declares every namespace prefix it uses, and marks them ignorable", () => {
    const used = new Set(
      [...raw.matchAll(/<\/?([a-z][\w]*):/g)].map((m) => m[1]),
    );
    const declared = new Set(
      [...raw.matchAll(/xmlns:([\w]+)=/g)].map((m) => m[1]),
    );
    expect([...used].filter((p) => !declared.has(p))).toEqual([]);

    const ignorable = new Set(
      (raw.match(/IgnorableNamespaces="([^"]*)"/)?.[1] ?? "").split(/\s+/),
    );
    expect([...used].filter((p) => !ignorable.has(p))).toEqual([]);
  });

  it("keeps the schema-mandated Package child order", () => {
    // makeappx validates against the Appx schema, which FIXES this sequence.
    // Reordering fails the pack, not the install.
    const expected = [
      "Identity",
      "Properties",
      "Dependencies",
      "Resources",
      "Applications",
      "Capabilities",
    ];
    const seen = expected.filter((tag) => raw.includes(`<${tag}`));
    expect(seen).toEqual(expected);
    const positions = expected.map((tag) => raw.indexOf(`<${tag}`));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("has exactly one version placeholder and no other unresolved token", () => {
    expect(raw).toContain('Version="{{VERSION}}"');
    const placeholders = [...new Set(raw.match(/\{\{[A-Z_]+\}\}/g) ?? [])];
    expect(placeholders).toEqual(["{{VERSION}}"]);
  });
});

describe("AppxManifest template — Store identity", () => {
  it("matches the values Partner Center assigned", () => {
    expect(raw).toContain(`Name="${IDENTITY_NAME}"`);
    // The local test certificate's subject must equal this EXACTLY or Windows
    // refuses the install (see docs/MSIX_RUNBOOK.md).
    expect(raw).toContain(`Publisher="${IDENTITY_PUBLISHER}"`);
    expect(raw).toContain(
      `<PublisherDisplayName>${PUBLISHER_DISPLAY_NAME}</PublisherDisplayName>`,
    );
  });

  it("targets x64 and a Windows 10 build old enough for the test machine", () => {
    expect(raw).toContain('ProcessorArchitecture="x64"');
    // 10.0.17763 = Windows 10 1809. Raising this would silently exclude the
    // Windows 10 box the spike runs on.
    expect(raw).toContain('MinVersion="10.0.17763.0"');
  });
});

describe("AppxManifest template — declarations the runtime depends on", () => {
  it("runs as a full-trust Win32 app", () => {
    // Without these, node-pty, child processes, and arbitrary filesystem access
    // behave like a UWP app rather than a normal desktop process.
    expect(raw).toContain('EntryPoint="Windows.FullTrustApplication"');
    expect(raw).toContain('<rescap:Capability Name="runFullTrust" />');
  });

  it("declares the atlarix:// protocol handler", () => {
    // THE load-bearing declaration. MSIX virtualizes HKCU writes, so
    // app.setAsDefaultProtocolClient cannot register the scheme — main.ts skips
    // it for Store builds and relies on this instead. Losing it silently breaks
    // Supabase OAuth, MCP OAuth, and the Lemon Squeezy atlarix://pro-return leg.
    expect(raw).toContain('Category="windows.protocol"');
    expect(raw).toContain('<uap:Protocol Name="atlarix">');
  });

  it("lets exactly the Chrome bridge registry keys reach the real registry", () => {
    // Chromium on Windows finds a native messaging host only via HKCU; with
    // MSIX registry virtualization on, the key is written to a package-private
    // hive no browser reads. Both halves are needed: the excluded keys AND the
    // restricted capability that permits them.
    const excluded = [...raw.matchAll(/<virtualization:ExcludedKey>([^<]+)<\/virtualization:ExcludedKey>/g)].map(
      (m) => m[1],
    );
    expect(excluded).toEqual(windowsRegistryKeys().map((k: string) => k.replace(/^HKCU\\/, "HKEY_CURRENT_USER\\")));
    expect(raw).toMatch(/<rescap:Capability Name="unvirtualizedResources"\s*\/>/);
  });

  it("never unvirtualizes all of HKCU again", () => {
    // The Store denied unvirtualizedResources twice (2026-09-28, 2026-10-07)
    // while the package switched registry virtualization off wholesale.
    expect(raw).not.toContain("RegistryWriteVirtualization>disabled");
    expect(raw).not.toContain("FileSystemWriteVirtualization");
  });

  it("declares the atlarix.exe execution alias", () => {
    // Needed to run the packaged self-test inside the container, and doubles as
    // the CLI entry point (`atlarix <dir>`).
    expect(raw).toContain('Category="windows.appExecutionAlias"');
    expect(raw).toContain('<desktop:ExecutionAlias Alias="atlarix.exe" />');
  });

  it("points Executable at the lowercase binary electron-packager emits", () => {
    // forge.config.ts sets `executableName: "atlarix"`, so the packaged binary is
    // atlarix.exe, not Atlarix.exe. A mismatch installs fine and fails to launch.
    expect(raw).toContain('Executable="atlarix.exe"');
    expect(raw).not.toContain('Executable="Atlarix.exe"');
  });

  it("references only logo assets that gen-icons.mjs actually produces", () => {
    const referenced = [...raw.matchAll(/Assets\\([\w.]+\.png)/g)].map(
      (m) => m[1],
    );
    expect(referenced.length).toBeGreaterThan(0);
    const assetsDir = path.join(process.cwd(), "build", "msix", "assets");
    for (const asset of new Set(referenced)) {
      expect(fs.existsSync(path.join(assetsDir, asset))).toBe(true);
    }
  });
});

describe("MSIX logo assets", () => {
  /** PNG IHDR width/height — MSIX rejects a logo whose real size differs. */
  function pngSize(file: string) {
    const buf = fs.readFileSync(file).subarray(0, 24);
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  it.each([
    ["StoreLogo.png", 50],
    ["Square44x44Logo.png", 44],
    ["Square150x150Logo.png", 150],
  ])("%s is exactly %ix%i and square", (name, size) => {
    const file = path.join(process.cwd(), "build", "msix", "assets", name);
    expect(fs.existsSync(file)).toBe(true);
    expect(pngSize(file)).toEqual({ width: size, height: size });
  });
});
