/**
 * Every PostHog event carries the Atlarix version, on every surface (calendar
 * task, 2026-10-22). The app's comes from Electron; the CLI, ACP and the VS Code
 * panel (which runs `atlarix acp`) run on the Electron stub, whose version is
 * `ATLARIX_VERSION`, set from the build in cli/entry.mts. Without it their
 * events said "0.0.0-headless".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured: Array<{ event: string; properties: Record<string, unknown> }> = [];
vi.mock("electron", async () => import("@/headless/electron-stub"));
vi.mock("posthog-node", () => ({
  PostHog: class {
    capture(e: { event: string; properties: Record<string, unknown> }) {
      captured.push(e);
    }
    identify() {}
    alias() {}
  },
}));
const settings = () => ({ telemetryConsent: "opted_in" });
vi.mock("@/main/settings", () => ({ readSettings: settings, writeSettings: () => {} }));
vi.mock("../main/settings", () => ({ readSettings: settings, writeSettings: () => {} }));

process.env.POSTHOG_API_KEY = "phc_test";
const { capture } = await import("@/main/lib/analytics");

const ENV = ["ATLARIX_VERSION", "ATLARIX_SURFACE", "ATLARIX_REPORT_SURFACE", "ATLARIX_ACP_EDITOR"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
beforeEach(() => {
  captured.length = 0;
  for (const k of ENV) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("the CLI and the editors send their version", () => {
  it.each([
    ["the terminal", { ATLARIX_SURFACE: "cli" }, "cli"],
    ["an editor over ACP", { ATLARIX_SURFACE: "cli", ATLARIX_REPORT_SURFACE: "acp", ATLARIX_ACP_EDITOR: "zed" }, "acp"],
    ["the VS Code panel", { ATLARIX_SURFACE: "cli", ATLARIX_REPORT_SURFACE: "vscode", ATLARIX_ACP_EDITOR: "Code" }, "vscode"],
  ] as const)("%s", (_label, env, surface) => {
    Object.assign(process.env, env, { ATLARIX_VERSION: "15.10.1" });
    capture("x");
    expect(captured[0]!.properties).toMatchObject({ surface, app_version: "15.10.1" });
  });
});
