/**
 * Host access — the half of a grant Chrome enforces.
 *
 * The assertion that matters is the ORDER: `permissions.request()` first, and
 * the stored record written only if it resolved true. `request()` resolves
 * FALSE when the user declines — it does not reject — so a record written
 * optimistically and "confirmed" afterwards claims access the browser never
 * gave, and every later read trusts it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canActOn,
  hasHostAccess,
  matchPatternFor,
  pruneRevokedGrants,
  requestHostAccess,
  revokeHostAccess,
} from "./host-access";
import { isGranted, listGrants } from "./site-grants";

interface Fake {
  store: Map<string, unknown>;
  held: Set<string>;
  request: ReturnType<typeof vi.fn>;
  /** Order of interesting operations, so the sequence itself can be asserted. */
  log: string[];
}

/**
 * Does held match pattern `held` cover requested pattern `want`?
 *
 * Enough of Chrome's match-pattern algebra for these tests: scheme wildcard,
 * host wildcard, `*.suffix` host wildcard, and a `/*` path. Deliberately not a
 * full implementation — an incomplete one that is honest about its scope beats
 * a sprawling one nobody trusts.
 */
function patternCovers(held: string, want: string): boolean {
  if (held === want) return true;
  const parse = (p: string) => {
    const m = /^(\*|https?):\/\/([^/]*)(\/.*)?$/.exec(p);
    return m ? { scheme: m[1]!, host: m[2]!, path: m[3] ?? "/" } : null;
  };
  const h = parse(held);
  const w = parse(want);
  if (!h || !w) return false;
  if (h.scheme !== "*" && h.scheme !== w.scheme) return false;
  if (h.host !== "*") {
    if (h.host.startsWith("*.")) {
      const suffix = h.host.slice(1); // ".example.com"
      if (!(w.host === h.host.slice(2) || w.host.endsWith(suffix))) return false;
    } else if (h.host !== w.host) {
      return false;
    }
  }
  return h.path === "/*" || h.path === w.path;
}

function installFakeChrome(opts: { grants?: boolean } = {}): Fake {
  const store = new Map<string, unknown>();
  /**
   * SEEDED, because that is what ships.
   *
   * `http://*&#47;*` and `https://*&#47;*` are REQUIRED `host_permissions` in
   * `manifest.json`, so Chrome grants them at install and every real profile
   * starts holding both. This set was empty until 2026-09-18 — the optional-era
   * shape — which quietly made every host-permission test here run against a
   * world that stopped existing on 2026-09-17.
   */
  const held = new Set<string>(["http://*/*", "https://*/*"]);
  const log: string[] = [];

  const area = {
    async get(key?: string | null) {
      return typeof key === "string" && store.has(key)
        ? { [key]: store.get(key) }
        : {};
    },
    async set(items: Record<string, unknown>) {
      log.push("storage.set");
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    },
    async remove(keys: string | string[]) {
      log.push("storage.remove");
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
    async clear() {
      store.clear();
    },
  };

  const request = vi.fn(async ({ origins }: { origins?: string[] }) => {
    log.push("permissions.request");
    if (opts.grants === false) return false;
    for (const o of origins ?? []) held.add(o);
    return true;
  });

  (globalThis as Record<string, unknown>).chrome = {
    storage: { local: area, sync: area },
    permissions: {
      request,
      async contains({ origins }: { origins?: string[] }) {
        // CHROME SUBSUMES PATTERNS, and a set lookup does not.
        //
        // This was `held.has(o)`, which answers "did we request this exact
        // string". Real `permissions.contains()` answers "is this covered",
        // so holding `https://*/*` makes a query for `https://a.example.com/*`
        // return TRUE. The difference is not academic: `host_permissions` now
        // declares the broad patterns, so EVERY `hasHostAccess` call in
        // production is a specific-origin query answered by a broad grant. An
        // exact-match fake reports every one of them as denied, which would fail
        // tests for a reason that cannot happen in Chrome — and, worse, let a
        // real "this origin is not covered" bug pass unnoticed.
        return (origins ?? []).every((o) =>
          [...held].some((h) => patternCovers(h, o)),
        );
      },
      async remove({ origins }: { origins?: string[] }) {
        log.push("permissions.remove");
        for (const o of origins ?? []) held.delete(o);
        return true;
      },
      onRemoved: { addListener: () => {} },
    },
  };
  return { store, held, request, log };
}

let fake: Fake;
beforeEach(() => {
  fake = installFakeChrome();
});

describe("matchPatternFor", () => {
  it("appends the path Chrome requires — a bare origin is rejected", () => {
    // Without `/*` the request throws rather than resolving false, which would
    // surface as an unexplained failure instead of a declined grant.
    expect(matchPatternFor("https://app.example.com/some/page?x=1")).toBe(
      "https://app.example.com/*",
    );
  });

  it("keeps a non-default port, which is part of the origin", () => {
    expect(matchPatternFor("http://localhost:5173/x")).toBe(
      "http://localhost:5173/*",
    );
  });

  it("is null for everything that is not http(s)", () => {
    for (const url of [
      "chrome://extensions",
      "file:///etc/passwd",
      "about:blank",
      "javascript:alert(1)",
    ]) {
      expect(matchPatternFor(url)).toBeNull();
    }
  });
});

describe("requestHostAccess", () => {
  it("asks Chrome FIRST and records only after it said yes", async () => {
    const outcome = await requestHostAccess("https://app.example.com/x");
    expect(outcome).toEqual({ ok: true });
    // The order is the point, not just that both happened.
    expect(fake.log).toEqual(["permissions.request", "storage.set"]);
    await expect(isGranted("https://app.example.com/x")).resolves.toBe(true);
  });

  it("records NOTHING when the user declines", async () => {
    fake = installFakeChrome({ grants: false });
    const outcome = await requestHostAccess("https://app.example.com/x");
    expect(outcome).toEqual({ ok: false, reason: "declined" });
    expect(fake.log).toContain("permissions.request");
    await expect(listGrants()).resolves.toEqual([]);
  });

  it("never even asks for a scheme that cannot hold a grant", async () => {
    const outcome = await requestHostAccess("chrome://extensions");
    expect(outcome).toEqual({ ok: false, reason: "unsupported-scheme" });
    expect(fake.request).not.toHaveBeenCalled();
  });

  it("asks for the ORIGIN, not the page", async () => {
    await requestHostAccess("https://app.example.com/deep/path?q=1#frag");
    expect(fake.request).toHaveBeenCalledWith({
      origins: ["https://app.example.com/*"],
    });
  });
});

describe("canActOn", () => {
  it("is true only when Chrome and the record agree", async () => {
    await requestHostAccess("https://app.example.com/x");
    await expect(canActOn("https://app.example.com/x")).resolves.toBe(true);
  });

  it("is FALSE when the user revoked host access behind our back", async () => {
    // Chrome lets a user revoke from chrome://extensions without telling us, so
    // the stored record outlives the permission. Trusting the record alone
    // would have the agent attempt an injection that fails with a permissions
    // error the model cannot act on.
    await requestHostAccess("https://app.example.com/x");
    fake.held.clear();
    await expect(isGranted("https://app.example.com/x")).resolves.toBe(true);
    await expect(canActOn("https://app.example.com/x")).resolves.toBe(false);
  });

  it("is false for a site never granted", async () => {
    await expect(canActOn("https://other.example.com/")).resolves.toBe(false);
  });
});

/**
 * Take back what the manifest grants at install, the way a user does from
 * `chrome://extensions` -> Site access -> "On specific sites".
 *
 * The two suites below are ONLY meaningful in that profile. On a default
 * install Chrome holds `http://*&#47;*` and `https://*&#47;*` as required
 * permissions, so `hasHostAccess` answers true for every http(s) origin,
 * `permissions.remove` cannot take a required permission back, and there is by
 * definition nothing for a prune to drop. Both suites asserted otherwise until
 * 2026-09-18 and passed only because the fake started with no permissions held.
 */
function narrowSiteAccess(f: Fake) {
  f.held.delete("http://*/*");
  f.held.delete("https://*/*");
}

describe("revokeHostAccess", () => {
  it("drops both halves — leaving either is a lie about the other", async () => {
    narrowSiteAccess(fake);
    await requestHostAccess("https://app.example.com/x");
    await revokeHostAccess("https://app.example.com/x");
    await expect(hasHostAccess("https://app.example.com/x")).resolves.toBe(
      false,
    );
    await expect(isGranted("https://app.example.com/x")).resolves.toBe(false);
  });

  it("cannot reduce Chrome's answer on a default install, and says so", async () => {
    // The broad patterns are REQUIRED, and Chrome refuses to hand a required
    // permission back. Our own record still clears, which is the half we own —
    // but the agent is not thereby locked out, and pretending otherwise in the
    // UI is how "Revoke" came to promise more than it delivers.
    await requestHostAccess("https://app.example.com/x");
    await revokeHostAccess("https://app.example.com/x");

    await expect(isGranted("https://app.example.com/x")).resolves.toBe(false);
    await expect(hasHostAccess("https://app.example.com/x")).resolves.toBe(
      true,
    );
  });
});

describe("pruneRevokedGrants", () => {
  it("drops records Chrome no longer backs, and reports which", async () => {
    narrowSiteAccess(fake);
    await requestHostAccess("https://a.example.com/");
    await requestHostAccess("https://b.example.com/");
    fake.held.delete("https://a.example.com/*");

    const dropped = await pruneRevokedGrants([
      "https://a.example.com/",
      "https://b.example.com/",
    ]);

    expect(dropped).toEqual(["https://a.example.com/"]);
    await expect(isGranted("https://a.example.com/")).resolves.toBe(false);
    await expect(isGranted("https://b.example.com/")).resolves.toBe(true);
  });

  it("drops nothing while the manifest's broad access is intact", async () => {
    await requestHostAccess("https://a.example.com/");

    await expect(
      pruneRevokedGrants(["https://a.example.com/"]),
    ).resolves.toEqual([]);
    await expect(isGranted("https://a.example.com/")).resolves.toBe(true);
  });
});

/*
 * The `describe("allowing every site")` block lived here until 2026-09-18 and is
 * gone with the feature.
 *
 * It is worth recording WHY it never caught the regression, because the shape
 * repeats. Its assertions were correct on the day they were written and became
 * a description of a no-op two days later, when host access moved from optional
 * to required — and one of them, `does NOT grant any site in our own record`,
 * had by then inverted into a test that PINNED the bug: it asserted that after
 * "Allow every site" nothing was granted and `canActOn` was still false, which
 * by then was the whole defect rather than the intended design.
 *
 * The fake below now seeds `held` with the required patterns, so a test that
 * assumes Chrome has to be asked for host access will fail instead of passing
 * against a world that no longer ships.
 */
