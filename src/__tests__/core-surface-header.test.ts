/**
 * The `X-Atlarix-Surface` header on every Core call.
 *
 * WHY IT NEEDS A TEST AND THE REST OF THAT WRAPPER DOES NOT. A wrong Authorization
 * header fails loudly and immediately — the proxy 401s and nobody ships it. A
 * missing surface header fails SILENTLY and permanently: the request succeeds,
 * the turn is charged, and the ledger row says `app` because that is the
 * server-side default. **A ledger row cannot be re-attributed later**, so every
 * turn sent before someone notices is indistinguishable from desktop spend
 * forever. There is no migration that fixes it afterwards.
 *
 * The value is asserted as a literal rather than by importing and comparing to
 * itself, because the point is the CONTRACT with the proxy's allowlist and the
 * database's CHECK constraint — a test that reads the constant would pass
 * happily after someone changed it to `desktop`, which the proxy would then
 * quietly map back to `app`.
 */

import { describe, expect, it } from "vitest";
import { ATLARIX_SURFACE } from "@/ipc/shared/core_proxy";

describe("the surface this build claims", () => {
  it("is exactly 'app'", () => {
    // Must match `USER_SURFACES` in atlarix-proxy/src/entitlement.ts and the
    // CHECK constraint on credit_transactions.source. The proxy falls back to
    // 'app' for anything it does not recognise, so a typo here is invisible in
    // every way except the ledger being wrong.
    expect(ATLARIX_SURFACE).toBe("app");
  });

  it("is NOT 'desktop', which would split the product across two rows", () => {
    // Every historical user-path row is already 'app'. Renaming means a backfill
    // of the whole table, or an account page that lists the same product twice.
    expect(ATLARIX_SURFACE).not.toBe("desktop");
  });
});

describe("the header reaches the proxy", () => {
  /**
   * Exercises the same shape `get_model_client.ts` builds: a `Headers` object
   * carrying the bearer and the surface. Asserting through `Headers` rather
   * than a plain object is deliberate — header names are case-insensitive
   * there, which is what the proxy's lowercase `c.req.header("x-atlarix-surface")`
   * relies on. A plain-object assertion would pass while the real lookup missed.
   */
  it("is readable under the lowercase name the proxy looks up", () => {
    const headers = new Headers();
    headers.set("Authorization", "Bearer token");
    headers.set("X-Atlarix-Surface", ATLARIX_SURFACE);

    expect(headers.get("x-atlarix-surface")).toBe("app");
    expect(headers.get("X-Atlarix-Surface")).toBe("app");
  });

  it("does not disturb the Authorization header it sits beside", () => {
    // The surface is a label. Who pays comes from the verified JWT, and these
    // two must never interfere — the proxy reads them independently.
    const headers = new Headers({ Authorization: "Bearer original" });
    headers.set("X-Atlarix-Surface", ATLARIX_SURFACE);
    expect(headers.get("Authorization")).toBe("Bearer original");
  });
});

describe("the call site", () => {
  it("sets the header in the Core fetch wrapper", async () => {
    // A source-text check, because the wrapper closes over a live Supabase
    // session and an AI-SDK provider — standing those up to observe one header
    // would test the harness rather than the header. What can go wrong here is
    // someone deleting the line during an unrelated edit, and that is exactly
    // what this catches.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(__dirname, "..", "ipc", "utils", "get_model_client.ts"),
      "utf8",
    );
    expect(source).toContain(
      'headers.set("X-Atlarix-Surface", ATLARIX_SURFACE)',
    );
    // And it must sit inside the SAME wrapper as the bearer, not somewhere a
    // refactor could leave it on a path Core calls do not take.
    const bearerAt = source.indexOf('headers.set("Authorization"');
    const surfaceAt = source.indexOf('headers.set("X-Atlarix-Surface"');
    expect(bearerAt).toBeGreaterThan(-1);
    expect(surfaceAt).toBeGreaterThan(bearerAt);
    expect(surfaceAt - bearerAt).toBeLessThan(1_000);
  });
});
