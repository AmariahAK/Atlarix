/**
 * Events that fired too often or said too little: the tier on every session
 * refresh, mode/model events from the app's settings diff only (Build and
 * Ask only, never the terminal or an editor), and app window events with no
 * surface. The turn's own event (`changed`) replaces the settings diff.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured: Array<{ event: string; properties: Record<string, unknown> }> = [];
const handlers = new Map<string, (...a: unknown[]) => unknown>();
let store: Record<string, unknown> = {};
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/atlarix-analytics-test", getVersion: () => "15.9.9" },
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock("posthog-node", () => ({
  PostHog: class {
    capture(e: { event: string; properties: Record<string, unknown> }) {
      captured.push(e);
    }
  },
}));
let consent = "opted_in";
const settings = () => ({ telemetryConsent: consent, ...store });
const write = (p: Record<string, unknown>) => {
  store = { ...store, ...p };
};
vi.mock("@/main/settings", () => ({ readSettings: settings, writeSettings: write, isSecretEncryptionAvailable: () => true }));
vi.mock("../main/settings", () => ({ readSettings: settings, writeSettings: write, isSecretEncryptionAvailable: () => true }));
vi.mock("../../main/settings", () => ({ readSettings: settings, writeSettings: write, isSecretEncryptionAvailable: () => true }));

process.env.POSTHOG_API_KEY = "phc_test";
const { trackTier, trackActiveDay, trackSessionStarted } = await import("@/main/lib/analytics");

beforeEach(() => {
  captured.length = 0;
  store = {};
  consent = "opted_in";
});

describe("tier_identified", () => {
  it("only when the tier changes, and as a person property", () => {
    trackTier("free");
    trackTier("free");
    trackTier("free");
    trackTier("pro");
    trackTier("pro");
    expect(captured.map((c) => c.properties.tier)).toEqual(["free", "pro"]);
    expect(captured[1]!.properties.$set).toEqual({ tier: "pro" });
  });
});

describe("the settings diff sends nothing", () => {
  it("a mode or model change is left to the next turn's event", async () => {
    const { registerSettingsHandlers } = await import("@/ipc/handlers/settings_handlers");
    registerSettingsHandlers();
    const set = handlers.get("set-user-settings")!;
    store = { selectedChatMode: "ask", selectedModel: { provider: "openai", name: "gpt-5" } };
    await set({}, { selectedChatMode: "build", selectedModel: { provider: "deepseek", name: "deepseek-v4-pro" } });
    const names = captured.map((c) => c.event);
    for (const e of ["build_mode_activated", "ask_mode_activated", "ai_model_selected"]) expect(names).not.toContain(e);
  });
});

describe("the app window's events", () => {
  it("say which surface and version sent them", async () => {
    const register = vi.fn();
    // With session replay's methods: a launch drawn for recording calls them (item 12).
    vi.doMock("posthog-js", () => ({
      default: { init: () => ({}), identify: () => {}, register, startSessionRecording: () => {}, stopSessionRecording: () => {} },
    }));
    vi.doMock("@/hooks/useSettings", () => ({ isTelemetryOptedIn: () => true }));
    const { setPostHogConfig, ensurePostHogInitialized } = await import("@/lib/analytics/posthog-client");
    setPostHogConfig("phc_test", "anon-1", "15.9.9");
    ensurePostHogInitialized();
    expect(register).toHaveBeenCalledWith({ surface: "app", app_version: "15.9.9" });
  });
});

describe("active_day", () => {
  const days = () => captured.filter((c) => c.event === "active_day");

  it("a day that began with analytics off is still sent once analytics is on, once", () => {
    consent = "opted_out";
    trackActiveDay();
    expect(days()).toHaveLength(0);
    consent = "opted_in";
    trackActiveDay();
    trackActiveDay();
    expect(days()).toHaveLength(1);
  });

  it("turning analytics on sends the day at once", async () => {
    consent = "opted_out";
    trackActiveDay();
    const { registerSettingsHandlers } = await import("@/ipc/handlers/settings_handlers");
    registerSettingsHandlers();
    // The handler's write is what turns it on (the store overrides `consent`).
    await handlers.get("set-user-settings")!({}, { telemetryConsent: "opted_in" });
    expect(days()).toHaveLength(1);
  });
});

describe("session_started", () => {
  it("a process that started with analytics off says so once they are turned on (QA, ai-48)", async () => {
    consent = "opted_out";
    trackSessionStarted({ how: "launch" });
    expect(captured.filter((c) => c.event === "session_started")).toHaveLength(0);
    const { registerSettingsHandlers } = await import("@/ipc/handlers/settings_handlers");
    registerSettingsHandlers();
    await handlers.get("set-user-settings")!({}, { telemetryConsent: "opted_in" });
    const started = captured.filter((c) => c.event === "session_started");
    expect(started).toHaveLength(1);
    expect(started[0]!.properties.how).toBe("launch");
    // Still once per process.
    trackSessionStarted({ how: "launch" });
    expect(captured.filter((c) => c.event === "session_started")).toHaveLength(1);
  });
});
