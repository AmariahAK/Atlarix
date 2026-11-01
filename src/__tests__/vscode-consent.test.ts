import { describe, expect, it } from "vitest";
import {
  CONSENT_DETAIL,
  DETAILS,
  NO,
  YES,
  consentFor,
  shouldAskConsent,
  agentTelemetryEnv,
} from "../../packages/vscode/src/consent";

describe("the editor asks about usage analytics once", () => {
  it("asks only when nobody answered anywhere, and only once from this editor", () => {
    expect(shouldAskConsent("unset", false)).toBe(true);
    expect(shouldAskConsent("unset", true)).toBe(false);
    // Answered in the app or the CLI: the same setting, never asked again here.
    expect(shouldAskConsent("opted_in", false)).toBe(false);
    expect(shouldAskConsent("opted_out", false)).toBe(false);
  });

  it("only the two buttons are an answer; closing it or Details is not", () => {
    expect(consentFor(YES)).toBe("opted_in");
    expect(consentFor(NO)).toBe("opted_out");
    expect(consentFor(DETAILS)).toBeNull();
    expect(consentFor(undefined)).toBeNull();
  });

  it("says the same as the app and the CLI", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const cli = readFileSync(join(__dirname, "..", "cli", "tui", "screens.ts"), "utf8");
    // Each paragraph the CLI shows appears word for word in the editor's details.
    for (const line of [
      "Share usage data — which features get used and whether they work.",
      "Never your code, prompts or files. Anonymous when signed out. Signed in, it's tied to your account (email and name) and includes your rough location from your connection, never the address itself.",
      "Not covered by this choice: crash reports (stack traces and device info), and for signed-in accounts a daily count of turns by surface, provider type, model and token size. Never prompts, code or keys.",
    ]) {
      expect(cli).toContain(line);
      expect(CONSENT_DETAIL).toContain(line);
    }
    expect(YES).toBe("Yes, that's fine");
    expect(NO).toBe("No thanks");
  });
});

describe("VS Code's own telemetry switch", () => {
  it("off: never asked, and the agent sends nothing", () => {
    expect(shouldAskConsent("unset", false, false)).toBe(false);
    expect(agentTelemetryEnv(false)).toEqual({ ATLARIX_HOST_TELEMETRY: "off" });
    expect(agentTelemetryEnv(false, "start_failed")).toEqual({ ATLARIX_HOST_TELEMETRY: "off" });
  });

  it("on: asked as before; a failed start last time is passed on to report", () => {
    expect(shouldAskConsent("unset", false, true)).toBe(true);
    expect(agentTelemetryEnv(true)).toEqual({});
    expect(agentTelemetryEnv(true, "cli_not_found")).toEqual({ ATLARIX_HOST_LAST_ERROR: "cli_not_found" });
  });
});
