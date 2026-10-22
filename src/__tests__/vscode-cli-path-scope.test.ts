/**
 * atlarix.cliPath names a program the extension runs. A folder's own
 * .vscode/settings.json must not be able to set it, or opening the panel in a
 * cloned repo the user trusted would run that repo's program (QA E9). Only the
 * user's own settings can: machine scope, as VS Code's own program paths are.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("atlarix.cliPath", () => {
  it("is machine-scoped, so a workspace's settings cannot set it", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../../packages/vscode/package.json"), "utf8"));
    const blocks = [manifest.contributes.configuration].flat();
    const cliPath = blocks.map((b: { properties?: Record<string, { scope?: string }> }) => b.properties?.["atlarix.cliPath"]).find(Boolean);
    expect(cliPath?.scope).toBe("machine");
  });
});
