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

import { afterEach, describe, expect, it } from "vitest";
import { atlarixEditor, atlarixSurface, surfaceHeaders } from "@/ipc/shared/core_proxy";

const ENV = ["ATLARIX_SURFACE", "ATLARIX_REPORT_SURFACE", "ATLARIX_ACP_EDITOR"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("the surface this build claims", () => {
  it("is exactly 'app' for the desktop", () => {
    // Must match the proxy's allowlist and the CHECK constraint on
    // credit_transactions.source. The proxy falls back to 'app' for anything it
    // does not recognise, so a typo here is invisible in every way except the
    // ledger being wrong.
    for (const k of ENV) delete process.env[k];
    expect(atlarixSurface()).toBe("app");
  });

  it("is NOT 'desktop', which would split the product across two rows", () => {
    // Every historical user-path row is already 'app'. Renaming means a backfill
    // of the whole table, or an account page that lists the same product twice.
    for (const k of ENV) delete process.env[k];
    expect(atlarixSurface()).not.toBe("desktop");
  });

  it("is 'cli' for the terminal, and the editor it serves for ACP and the VS Code panel", () => {
    process.env.ATLARIX_SURFACE = "cli";
    delete process.env.ATLARIX_REPORT_SURFACE;
    expect(atlarixSurface()).toBe("cli");
    process.env.ATLARIX_REPORT_SURFACE = "acp";
    expect(atlarixSurface()).toBe("acp");
    process.env.ATLARIX_REPORT_SURFACE = "vscode";
    expect(atlarixSurface()).toBe("vscode");
    // Anything else is not a surface the proxy knows: report the process type.
    process.env.ATLARIX_REPORT_SURFACE = "desktop";
    expect(atlarixSurface()).toBe("cli");
  });

  it("names the editor only when there is one", () => {
    delete process.env.ATLARIX_ACP_EDITOR;
    expect(atlarixEditor()).toBe("");
    expect(surfaceHeaders()).not.toHaveProperty("X-Atlarix-Editor");
    process.env.ATLARIX_REPORT_SURFACE = "vscode";
    process.env.ATLARIX_ACP_EDITOR = "  Cursor ";
    expect(surfaceHeaders()).toEqual({ "X-Atlarix-Surface": "vscode", "X-Atlarix-Editor": "Cursor" });
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
    for (const k of ENV) delete process.env[k];
    const headers = new Headers();
    headers.set("Authorization", "Bearer token");
    for (const [k, v] of Object.entries(surfaceHeaders())) headers.set(k, v);

    expect(headers.get("x-atlarix-surface")).toBe("app");
    expect(headers.get("X-Atlarix-Surface")).toBe("app");
  });

  it("does not disturb the Authorization header it sits beside", () => {
    // The surface is a label. Who pays comes from the verified JWT, and these
    // two must never interfere — the proxy reads them independently.
    const headers = new Headers({ Authorization: "Bearer original" });
    for (const [k, v] of Object.entries(surfaceHeaders())) headers.set(k, v);
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
      "for (const [k, v] of Object.entries(surfaceHeaders())) headers.set(k, v);",
    );
    // And it must sit inside the SAME wrapper as the bearer, not somewhere a
    // refactor could leave it on a path Core calls do not take.
    const bearerAt = source.indexOf('headers.set("Authorization"');
    const surfaceAt = source.indexOf("Object.entries(surfaceHeaders())");
    expect(bearerAt).toBeGreaterThan(-1);
    expect(surfaceAt).toBeGreaterThan(bearerAt);
    expect(surfaceAt - bearerAt).toBeLessThan(1_000);
  });
});
