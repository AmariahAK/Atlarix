import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

/**
 * Guard the `patches/@electron+node-gyp+10.2.0-electron.1.patch` VS-2026 hunks.
 *
 * WHY A TEST OVER A DEPENDENCY'S FILE, which is unusual: a patch-package patch is
 * the one kind of change in this repo that can vanish without anybody editing
 * anything. A dependency bump renames the patch's target version, postinstall skips
 * it with a warning nobody reads, and the next Windows build fails with "Could not
 * find any Visual Studio installation to use" — a message that names neither node-gyp
 * nor the patch. That is what the 1 MB `maxBuffer` hunk in the same file cost on the
 * v14.35.0 tag.
 *
 * `scripts/check-vs-toolchain.mjs` is the other half and the stronger check, but it
 * can only run on a Windows host with a real Visual Studio. This half runs
 * everywhere, because `getVersionInfo` and `getToolset` are synchronous pure-ish
 * methods that never touch the registry or PowerShell.
 */
const require = createRequire(import.meta.url);
const VisualStudioFinder =
  require("@electron/node-gyp/lib/find-visualstudio") as any;

/** The finder only reads `.major`, and only to gate the VS2015/2017 fallbacks. */
function finder() {
  return new VisualStudioFinder({ major: 24 }, undefined);
}

const VC_TOOLS = "Microsoft.VisualStudio.Component.VC.Tools.x86.x64";

describe("node-gyp VS 2026 patch", () => {
  it("maps major 18 to year 2026", () => {
    expect(finder().getVersionInfo({ version: "18.8.2.0" }).versionYear).toBe(
      2026,
    );
  });

  it("leaves the pre-existing majors alone", () => {
    const f = finder();
    expect(f.getVersionInfo({ version: "17.14.0.0" }).versionYear).toBe(2022);
    expect(f.getVersionInfo({ version: "16.11.0.0" }).versionYear).toBe(2019);
    expect(f.getVersionInfo({ version: "15.9.0.0" }).versionYear).toBe(2017);
  });

  it("still gives up on a major it does not know", () => {
    // Deliberate: the major->year map is NOT linear (15->2017, 16->2019, 17->2022),
    // so a year for major 19 would be invented rather than known. If this ever
    // starts returning a year, someone added a generic `>=` rule and guessed.
    expect(
      finder().getVersionInfo({ version: "19.0.0.0" }).versionYear,
    ).toBeUndefined();
  });

  it("all three discovery paths accept 2026", () => {
    // findVSFromSpecifiedLocation / findNewVSUsingSetupModule / findNewVS each carry
    // their own supportedYears array, and `processData` filters on it. Missing one
    // means VS 2026 is found and then silently discarded as "unsupported version".
    const src = require("node:fs").readFileSync(
      require.resolve("@electron/node-gyp/lib/find-visualstudio"),
      "utf8",
    ) as string;
    expect(src.match(/\[2019, 2022, 2026\]/g)).toHaveLength(3);
    expect(src).not.toContain("[2019, 2022]");
  });

  it("returns a non-empty toolset for 2026 even when nothing is on disk", () => {
    // `toolset` is the SOLE source of <PlatformToolset> in the generated .vcxproj,
    // and `processData` DISCARDS any install whose toolset is falsy — which lands
    // back on "Could not find any Visual Studio installation to use" with a
    // misleading cause. So the 2026 branch must never return null.
    const toolset = finder().getToolset(
      { path: "/definitely/not/a/visual/studio", packages: [VC_TOOLS] },
      2026,
    );
    expect(toolset).toBe("v143");
  });

  it("still returns null when the VC++ tools component is absent", () => {
    // The fallback above must not paper over a genuinely toolset-less install
    // (Build Tools without the C++ workload) — that one SHOULD be rejected.
    expect(
      finder().getToolset({ path: "/nope", packages: [] }, 2026),
    ).toBeNull();
  });

  it("prefers the highest vNNN found under PlatformToolsets", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const os = require("node:os") as typeof import("node:os");
    const path = require("node:path") as typeof import("node:path");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vs2026-"));
    // Mirror the real layout, with two VC target dirs and three toolsets, so
    // "highest wins", "scan every VC dir" and "ignore ClangCL" are all exercised.
    for (const [vcDir, toolsets] of [
      ["v170", ["v142", "v143"]],
      ["v180", ["v145", "ClangCL"]],
    ] as const) {
      for (const ts of toolsets) {
        fs.mkdirSync(
          path.join(
            root,
            "MSBuild",
            "Microsoft",
            "VC",
            vcDir,
            "Platforms",
            "x64",
            "PlatformToolsets",
            ts,
          ),
          { recursive: true },
        );
      }
    }
    try {
      expect(
        finder().getToolset({ path: root, packages: [VC_TOOLS] }, 2026),
      ).toBe("v145");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the maxBuffer hunk", () => {
    // Same file, same patch. If a regeneration drops this, PowerShell's
    // Get-VSSetupInstance JSON blows Node's 1 MB default again and every VS check
    // fails at once — the v14.35.0 failure.
    const src = require("node:fs").readFileSync(
      require.resolve("@electron/node-gyp/lib/find-visualstudio"),
      "utf8",
    ) as string;
    expect(src).toContain("maxBuffer: 64 * 1024 * 1024");
  });
});
