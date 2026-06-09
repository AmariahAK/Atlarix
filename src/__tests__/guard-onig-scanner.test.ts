/**
 * v12.10: guard onigasm's OnigScanner so a look-behind pattern the old engine
 * rejects degrades to "no match" instead of throwing on every tokenized line
 * (which flooded the console and Sentry when opening e.g. a Python workspace).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  guardOnigScanner,
  __resetOnigGuardForTests,
} from "@/lib/monaco/guard-onig-scanner";

describe("guardOnigScanner", () => {
  beforeEach(() => __resetOnigGuardForTests());

  it("swallows a throwing findNextMatchSync and returns null", () => {
    class FakeOnigScanner {
      findNextMatchSync(): unknown {
        throw new Error("invalid pattern in look-behind");
      }
      findNextMatch(): unknown {
        throw new Error("invalid pattern in look-behind");
      }
    }
    guardOnigScanner({ OnigScanner: FakeOnigScanner });
    const scanner = new FakeOnigScanner();
    expect(() => scanner.findNextMatchSync()).not.toThrow();
    expect(scanner.findNextMatchSync()).toBeNull();
    expect(scanner.findNextMatch()).toBeNull();
  });

  it("passes through successful matches unchanged", () => {
    const ok = { index: 0 };
    class FakeOnigScanner {
      findNextMatchSync(): unknown {
        return ok;
      }
    }
    guardOnigScanner({ OnigScanner: FakeOnigScanner });
    expect(new FakeOnigScanner().findNextMatchSync()).toBe(ok);
  });

  it("is idempotent (does not double-wrap)", () => {
    let calls = 0;
    class FakeOnigScanner {
      findNextMatchSync(): unknown {
        calls++;
        throw new Error("boom");
      }
    }
    guardOnigScanner({ OnigScanner: FakeOnigScanner });
    __resetOnigGuardForTests(); // simulate a second init pass
    guardOnigScanner({ OnigScanner: FakeOnigScanner });
    new FakeOnigScanner().findNextMatchSync();
    // One real call beneath one layer of wrapping — not wrapped twice.
    expect(calls).toBe(1);
  });
});
