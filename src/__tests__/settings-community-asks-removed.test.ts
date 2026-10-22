/**
 * "Where did you hear about Atlarix?" and "Review us on PeerPush" are gone
 * (owner, 2026-10-22: "let others naturally choose to speak on us"). Settings
 * files from earlier versions still hold their answers; those keys must stay
 * harmless: read without error, and kept on disk by a later write like any key
 * this version doesn't know.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-settings-asks-"));
vi.mock("@/paths/paths", () => ({ getUserDataPath: () => userDataDir }));
afterAll(() => fs.rmSync(userDataDir, { recursive: true, force: true }));

const OLD = {
  hasRunBefore: true,
  telemetryConsent: "opted_in",
  acquisitionSource: { userId: "u1", source: "github", answeredAt: 1 },
  acquisitionPromptDismissedFor: "u2",
  peerPushPrompt: { askedAt: 2, clickedThroughAt: 3 },
  activeDayCount: 9,
};

describe("settings from before the community asks were removed", () => {
  it("load, and survive a later write", async () => {
    const file = path.join(userDataDir, "user-settings.json");
    fs.writeFileSync(file, JSON.stringify(OLD));
    const { readSettings, writeSettings } = await import("@/main/settings");
    const s = readSettings();
    expect(s.hasRunBefore).toBe(true);
    expect(s.telemetryConsent).toBe("opted_in");
    writeSettings({ lastActiveDay: "2026-10-22" });
    const out = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(out.lastActiveDay).toBe("2026-10-22");
    expect(out.peerPushPrompt).toEqual(OLD.peerPushPrompt);
  });

  it("no Settings section or app code asks either question any more", () => {
    const src = path.join(__dirname, "..");
    const nav = fs.readFileSync(path.join(src, "pages", "settings.tsx"), "utf8");
    expect(nav).not.toContain("/settings/community");
    expect(fs.existsSync(path.join(src, "components", "community"))).toBe(false);
    expect(fs.existsSync(path.join(src, "lib", "community", "acquisition.ts"))).toBe(false);
  });
});
