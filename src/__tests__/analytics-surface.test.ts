/**
 * Every event says which Atlarix sent it: the app, the CLI, or an editor (acp
 * for Zed and JetBrains, vscode for our panel) and which one. Before, an
 * editor's events all said `cli`. Plus the new per-turn and per-session
 * events, and our own accounts marked so they can be filtered out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured: Array<{ event: string; properties: Record<string, unknown> }> = [];
const identified: Array<{ distinctId: string; properties?: Record<string, unknown> }> = [];
let consent = "opted_in";
vi.mock("electron", () => ({ app: { getPath: () => "/tmp/atlarix-analytics-test", getVersion: () => "15.9.9" } }));
vi.mock("posthog-node", () => ({
  PostHog: class {
    capture(e: { event: string; properties: Record<string, unknown> }) {
      captured.push(e);
    }
    identify(e: { distinctId: string; properties?: Record<string, unknown> }) {
      identified.push(e);
    }
    alias() {}
  },
}));
const settings = () => ({ telemetryConsent: consent, analyticsAliasedUserIds: ["u1", "u2"] });
vi.mock("@/main/settings", () => ({ readSettings: settings, writeSettings: () => {} }));
vi.mock("../main/settings", () => ({ readSettings: settings, writeSettings: () => {} }));

process.env.POSTHOG_API_KEY = "phc_test";
const { capture, identifyUser, trackSessionStarted, trackTurnCompleted } = await import("@/main/lib/analytics");

const ENV = ["ATLARIX_SURFACE", "ATLARIX_REPORT_SURFACE", "ATLARIX_ACP_EDITOR"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

beforeEach(() => {
  captured.length = 0;
  identified.length = 0;
  consent = "opted_in";
  for (const k of ENV) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("every event says where it came from", () => {
  it("the desktop app", () => {
    capture("x");
    expect(captured[0]!.properties).toMatchObject({ surface: "app", app_version: "15.9.9", os: process.platform, arch: process.arch });
    expect(captured[0]!.properties).not.toHaveProperty("editor");
  });

  it("the terminal", () => {
    process.env.ATLARIX_SURFACE = "cli";
    capture("x");
    expect(captured[0]!.properties.surface).toBe("cli");
  });

  it("an editor over ACP, and which one", () => {
    process.env.ATLARIX_SURFACE = "cli";
    process.env.ATLARIX_REPORT_SURFACE = "acp";
    process.env.ATLARIX_ACP_EDITOR = "zed";
    capture("x");
    expect(captured[0]!.properties).toMatchObject({ surface: "acp", editor: "zed" });
  });

  it("our VS Code panel, in whichever VS Code-family editor", () => {
    process.env.ATLARIX_SURFACE = "cli";
    process.env.ATLARIX_REPORT_SURFACE = "vscode";
    process.env.ATLARIX_ACP_EDITOR = "Cursor";
    capture("x");
    expect(captured[0]!.properties).toMatchObject({ surface: "vscode", editor: "Cursor" });
  });

  it("an event's own properties win over the shared ones", () => {
    capture("x", { os: "custom" });
    expect(captured[0]!.properties.os).toBe("custom");
  });
});

describe("turn_completed and session_started", () => {
  it("one turn_completed per turn, with how it ended", async () => {
    trackTurnCompleted({ chatId: 1, end: { outcome: "ask_user" }, mode: "build", durationMs: 1, hadHistory: false, outputTokens: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(captured.map((c) => c.event)).toContain("turn_completed");
    expect(captured.find((c) => c.event === "turn_completed")!.properties).toMatchObject({
      outcome: "ask_user",
      mode: "build",
      surface: "app",
    });
  });

  it("session_started fires once per process", () => {
    trackSessionStarted();
    trackSessionStarted();
    expect(captured.filter((c) => c.event === "session_started")).toHaveLength(1);
  });

  it("sends nothing without consent", () => {
    consent = "opted_out";
    trackTurnCompleted({ chatId: 2, end: { outcome: "ok" }, durationMs: 1, hadHistory: false, outputTokens: 1 });
    expect(captured).toEqual([]);
  });
});

describe("our own accounts are marked internal", () => {
  it("marks an internal email, case-insensitively", () => {
    identifyUser("u1", { email: "Agent@Atlarix.dev", name: "x" });
    expect(identified[0]!.properties).toMatchObject({ internal: true });
  });

  it("marks everyone else as not internal", () => {
    identifyUser("u2", { email: "someone@example.com" });
    expect(identified[0]!.properties).toMatchObject({ internal: false });
  });
});
