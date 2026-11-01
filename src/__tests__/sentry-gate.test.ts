/**
 * 0t: the two gates that keep the production Sentry project out of test/QA/dev
 * builds. The bun suite (tests-bun/sentry-gate.test.ts) proves the real
 * `installProcessGuards` path sends nothing; this locks the pure logic under
 * the default `npm test` (vitest) too.
 */
import { describe, expect, it } from "vitest";
import { sentryDsnForBuild, sentryInitAllowed } from "@/lib/sentry-gate";

const DSN = "https://abc123@o1.ingest.de.sentry.io/4510981520425040";

describe("sentry gate", () => {
  it("embeds a DSN only for an explicit release build", () => {
    // Dev/QA builds (no ATLARIX_RELEASE) embed none, prod DSN present or not.
    expect(sentryDsnForBuild({ SENTRY_DSN: DSN })).toBe("");
    expect(sentryDsnForBuild({})).toBe("");
    expect(sentryDsnForBuild({ ATLARIX_RELEASE: "1", SENTRY_DSN: DSN })).toBe(DSN);
    expect(sentryDsnForBuild({ ATLARIX_RELEASE: "1", ATLARIX_SENTRY_DSN: DSN })).toBe(DSN);
  });

  it("allows init only when the run is not marked disabled", () => {
    expect(sentryInitAllowed({})).toBe(true);
    expect(sentryInitAllowed({ ATLARIX_SENTRY_DISABLED: "1" })).toBe(false);
  });
});
