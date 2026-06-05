import fs from "node:fs";
import path from "node:path";
import { getUserDataDirOverride } from "./user-data-override";

/**
 * Seed user-settings.json in the test userData dir. `readSettings()` merges
 * the file over DEFAULT_SETTINGS, so partial overrides are enough.
 *
 * Typical eval settings:
 *   writeTestSettings({
 *     selectedModel: { name: modelName, provider: providerId },
 *     selectedChatMode: "build",
 *     autoApproveChanges: true,
 *   });
 */
export function writeTestSettings(overrides: Record<string, unknown>): void {
  const dir = getUserDataDirOverride();
  if (!dir) {
    throw new Error(
      "writeTestSettings: no userData override — call makeTestDb() first",
    );
  }
  const file = path.join(dir, "user-settings.json");
  const current = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf-8"))
    : {};
  fs.writeFileSync(file, JSON.stringify({ ...current, ...overrides }, null, 2));
}
