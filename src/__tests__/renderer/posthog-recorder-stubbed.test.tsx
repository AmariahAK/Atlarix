/**
 * No renderer test loads PostHog's real session recorder. posthog-client
 * imports it at the top, so any component reaching useSettings did, and on a
 * slow CI runner the load outlived the test's environment: 24
 * EnvironmentTeardownErrors on dev a2bc57eb (vitest.renderer.setup.ts).
 * Loaded for real, the recorder installs `__PosthogExtensions__.rrweb`.
 */
import { describe, expect, it } from "vitest";

describe("the session recorder in renderer tests", () => {
  it("is the stub: importing the client loads nothing real", async () => {
    await import("@/lib/analytics/posthog-client");
    const ext = (window as unknown as { __PosthogExtensions__?: { rrweb?: unknown } }).__PosthogExtensions__;
    expect(ext?.rrweb).toBeUndefined();
  });
});
