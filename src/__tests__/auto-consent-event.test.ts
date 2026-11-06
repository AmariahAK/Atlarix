/**
 * auto_consent: whether the free Atlarix Auto consent stops people (owner,
 * 2026-11-06). Shown, accepted or declined, what opened it, and the wording's
 * version. It goes through the analytics gate like every other event: nothing
 * is sent without the user's yes to analytics.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured: Array<[string, Record<string, unknown> | undefined]> = [];
vi.mock("@/main/lib/analytics", () => ({
  captureSafe: (event: string, properties?: Record<string, unknown>) => captured.push([event, properties]),
}));

const { autoConsentProperties, AUTO_CONSENT_EVENT } = await import("@/lib/analytics/auto-consent-event");
const { trackAutoConsent } = await import("@/lib/analytics/auto-consent-track");
const { ATLARIX_AUTO_CONSENT_VERSION } = await import("@/ipc/shared/compass_constants");

beforeEach(() => {
  captured.length = 0;
});

describe("auto_consent", () => {
  it("carries the action, what opened it and the wording's version", () => {
    expect(AUTO_CONSENT_EVENT).toBe("auto_consent");
    expect(autoConsentProperties("declined", "refused_turn")).toEqual({
      action: "declined",
      trigger: "refused_turn",
      version: ATLARIX_AUTO_CONSENT_VERSION,
    });
  });

  it("the CLI and editors send it through the analytics gate", async () => {
    trackAutoConsent("shown", "reask");
    await vi.waitFor(() => expect(captured).toHaveLength(1));
    expect(captured[0]).toEqual(["auto_consent", { action: "shown", trigger: "reask", version: ATLARIX_AUTO_CONSENT_VERSION }]);
  });
});
