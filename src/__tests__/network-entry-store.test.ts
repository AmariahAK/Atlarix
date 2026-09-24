/**
 * The shared network-entry helpers. The per-tab stores this file used to cover
 * went with the in-app agent browser in v14.52.0; capture is the extension's.
 */
import { describe, expect, it } from "vitest";
import {
  formatNetworkRow,
  isFailure,
  type NetworkEntry,
} from "@/lib/browser/network-entry";

function started(id: string, over: Partial<NetworkEntry> = {}): NetworkEntry {
  return {
    id,
    tabId: 1,
    url: `https://example.com/${id}`,
    method: "GET",
    startedAt: 1_000,
    source: "cdp",
    ...over,
  };
}

describe("isFailure", () => {
  it("counts transport errors and 4xx/5xx, not successes", () => {
    expect(isFailure(started("a", { failed: true }))).toBe(true);
    expect(isFailure(started("b", { status: 500 }))).toBe(true);
    expect(isFailure(started("c", { status: 404 }))).toBe(true);
    expect(isFailure(started("d", { status: 200 }))).toBe(false);
    expect(isFailure(started("e", { status: 301 }))).toBe(false);
    // In flight — no verdict yet.
    expect(isFailure(started("f"))).toBe(false);
  });
});

describe("formatNetworkRow", () => {
  it("says FAILED for a transport error and leaves unknown sizes out", () => {
    expect(
      formatNetworkRow(started("a", { failed: true, errorText: "net::ERR_FAILED" })),
    ).toBe("• [FAILED net::ERR_FAILED] GET https://example.com/a");
    expect(
      formatNetworkRow(
        started("b", { status: 200, resourceType: "fetch", durationMs: 12 }),
      ),
    ).toBe("• [200] GET https://example.com/b (fetch, 12ms)");
  });
});
