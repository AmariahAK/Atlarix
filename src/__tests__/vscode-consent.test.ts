import { describe, expect, it } from "vitest";
import {
  CONSENT_DETAIL,
  DETAILS,
  NO,
  YES,
  consentFor,
  shouldAskConsent,
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
      "Never your code, prompts, file names, or file contents.",
      "Includes your approximate location (country and city), worked out from your connection; the address itself isn't kept.",
      "Crash and error reports are sent separately and are not covered by this choice",
    ]) {
      expect(cli).toContain(line);
      expect(CONSENT_DETAIL).toContain(line);
    }
    expect(YES).toBe("Yes, that's fine");
    expect(NO).toBe("No thanks");
  });
});
