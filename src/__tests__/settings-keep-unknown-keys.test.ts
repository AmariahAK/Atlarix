/**
 * A settings key this version doesn't know was written by a newer Atlarix on
 * the same machine (the app, the CLI and the editor extension update
 * separately). Writing must keep it: 15.7.0 dropped 15.7.1's consent version
 * and MCP defaults on its first save (QA 15.7.1 #8).
 */
import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const userDataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "atlarix-settings-keep-"),
);
vi.mock("@/paths/paths", () => ({ getUserDataPath: () => userDataDir }));

describe("writing settings", () => {
  it("keeps keys from a newer version, and still writes its own", async () => {
    const file = path.join(userDataDir, "user-settings.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        hasRunBefore: true,
        someFutureSetting: { a: 1 },
        defaultMcpServersV9: ["x"],
      }),
    );
    const { writeSettings } = await import("@/main/settings");
    writeSettings({ atlarixAutoConsentVersion: 2 });
    const out = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(out.someFutureSetting).toEqual({ a: 1 });
    expect(out.defaultMcpServersV9).toEqual(["x"]);
    expect(out.atlarixAutoConsentVersion).toBe(2);
    expect(out.hasRunBefore).toBe(true);
  });
});
