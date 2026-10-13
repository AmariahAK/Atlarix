import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("deleting a custom provider takes its saved key with it (owner)", () => {
  it("forgets keys of custom providers that no longer exist, and nothing else", async () => {
    process.env.ATLARIX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "prune-"));
    const { writeProviderKey, pruneCustomProviderSettings, readSettings } = await import("../src/main/settings");
    writeProviderKey("custom::keep-me", "k1-xxxxxxxxxxxx");
    writeProviderKey("custom::qa-ai49-bad", "k2-xxxxxxxxxxxx");
    writeProviderKey("deepseek", "k3-xxxxxxxxxxxx");
    expect(pruneCustomProviderSettings(new Set(["custom::keep-me"]))).toEqual(["custom::qa-ai49-bad"]);
    const left = Object.keys((readSettings() as { providerSettings?: Record<string, unknown> }).providerSettings ?? {}).sort();
    expect(left).toEqual(["custom::keep-me", "deepseek"]);
  });
});
