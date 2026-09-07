import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Settings and Integrations must stay separated by KIND.
 *
 * WHAT THIS FILE USED TO DO, AND WHY IT DOESN'T ANY MORE
 * ------------------------------------------------------
 * It checked that every sidebar entry matched a real `<div id="…">` on the
 * settings page. That mattered while sections were anchors on one long scroll:
 * `SettingsList.tsx` opened with a comment warning that an entry with no
 * matching section "is a dead link that silently does nothing", and cited
 * `team` as a past instance. The comment was the only enforcement, so it
 * happened again — moving the per-project settings deleted three sections and
 * would have left three dead entries behind.
 *
 * Both pages are one-section-per-ROUTE now, and TanStack's `to` is a typed
 * union: a wrong path fails to compile. That is a strictly better guard than
 * this file could ever be, so the id-parity assertions are gone rather than
 * maintained against markup that no longer has ids.
 *
 * RETARGETED 2026-09-07. `SettingsList.tsx` / `IntegrationsList.tsx` were the
 * sidebar sub-nav, deleted because they duplicated the top tab row route-for-route
 * (verified: neither set contained a destination the other lacked). The lists this
 * now reads are the `SECTIONS` arrays that feed those tabs — same shape, same
 * decision, same guarantee.
 *
 * WHAT SURVIVES is the part a compiler cannot check: the SPLIT itself. Nothing
 * stops someone adding "Models & providers" back to the Settings nav, and one
 * label in both places is a user wondering which is real. The rule:
 *
 *   Settings      — preferences. How the app behaves for you.
 *   Integrations  — connections, and the policy governing what they may do.
 */

const SRC = path.join(__dirname, "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), "utf-8");
}

/**
 * The `SECTIONS` block from a page, as source text.
 *
 * Scoped to the block rather than the whole file ON PURPOSE: `settings.tsx` has
 * prose reading "Model providers, MCP servers, Skills and project permissions live
 * under Integrations", and the label guard below would match that sentence and fail
 * on a page that is entirely correct.
 */
function sectionsBlock(rel: string): string {
  const source = read(rel);
  const start = source.indexOf("const SECTIONS = [");
  expect(
    start,
    `${rel}: no \`const SECTIONS = [\` — re-point this guard rather than deleting it`,
  ).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("] as const", start));
}

/** Route paths from a nav list's `{ to: "…" }` entries, in order. */
function navRoutes(rel: string): string[] {
  return [...sectionsBlock(rel).matchAll(/\bto:\s*"([^"]+)"/g)].map((m) => m[1]!);
}

describe("Settings ↔ Integrations split", () => {
  it("Settings lists only /settings routes", () => {
    const routes = navRoutes("pages/settings.tsx");
    expect(routes.length).toBeGreaterThan(5);
    const strays = routes.filter((r) => !r.startsWith("/settings"));
    expect(
      strays,
      "Settings is preferences only — connections belong to the Integrations page",
    ).toEqual([]);
  });

  it("Integrations lists only /integrations routes", () => {
    const routes = navRoutes("pages/integrations.tsx");
    expect(routes.length).toBeGreaterThan(3);
    const strays = routes.filter((r) => !r.startsWith("/integrations"));
    expect(strays).toEqual([]);
  });

  it("the two navs share no route", () => {
    const settings = new Set(navRoutes("pages/settings.tsx"));
    const integrations = navRoutes("pages/integrations.tsx");
    const both = integrations.filter((r) => settings.has(r));
    expect(both, "one entry in both navs is a user asking which is real").toEqual(
      [],
    );
  });

  it("Settings names nothing that is a connection", () => {
    // Guards the seam by LABEL as well as by route, because the tempting
    // regression is a helpful shortcut ("Models & providers") rather than a
    // wrongly-pathed link.
    const source = sectionsBlock("pages/settings.tsx").toLowerCase();
    for (const word of ["provider", "mcp", "skill", "github", "permission"]) {
      expect(
        source.includes(`label: "${word}`) || source.includes(` ${word}`),
        `"${word}" reads like a connection; it belongs under Integrations`,
      ).toBe(false);
    }
  });

  it("Settings leads with General, Integrations with providers", () => {
    // Order is a product decision worth pinning: Settings opens on what this
    // install IS; Integrations opens on the thing most people came to do.
    expect(navRoutes("pages/settings.tsx")[0]).toBe("/settings");
    expect(navRoutes("pages/integrations.tsx")[0]).toBe(
      "/integrations",
    );
  });
});
