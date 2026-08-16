/**
 * The per-tab network log.
 *
 * Per TAB, not per window — a single shared buffer means one chatty tab evicts
 * another's history, which is the exact bug console and network had before they
 * were split. It is also what makes the "one card per tab" view possible without
 * filtering.
 */

import { describe, expect, it } from "vitest";
import {
  NETWORK_ENTRIES_PER_TAB_MAX,
  beginRequest,
  completeRequest,
  createTabNetworkLog,
  flattenHeaders,
  isFailure,
  sizeFromHeaders,
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

describe("per-tab network log", () => {
  it("moves a request from pending to entries on completion", () => {
    const log = createTabNetworkLog(1);
    beginRequest(log, started("r1"));
    expect(log.pending.size).toBe(1);
    expect(log.entries).toHaveLength(0);

    const done = completeRequest(log, "r1", { status: 200, finishedAt: 1_250 });

    expect(log.pending.size).toBe(0);
    expect(log.entries).toHaveLength(1);
    expect(done?.status).toBe(200);
    expect(done?.durationMs).toBe(250);
  });

  it("records a response for a request it never saw start", () => {
    // Capture begins after the tab exists, so a request can already be in flight.
    // Half a record beats silently dropping it.
    const log = createTabNetworkLog(1);
    const done = completeRequest(
      log,
      "unseen",
      { status: 500 },
      { tabId: 1, url: "https://api.test/x", method: "POST", source: "cdp" },
    );
    expect(done).not.toBeNull();
    expect(log.entries).toHaveLength(1);
    expect(done?.method).toBe("POST");
  });

  it("drops a response it cannot attribute at all", () => {
    const log = createTabNetworkLog(1);
    expect(completeRequest(log, "ghost", { status: 200 })).toBeNull();
    expect(log.entries).toHaveLength(0);
  });

  it("caps per tab, keeping the newest", () => {
    const log = createTabNetworkLog(1);
    for (let i = 0; i < NETWORK_ENTRIES_PER_TAB_MAX + 120; i++) {
      beginRequest(log, started(`r${i}`));
      completeRequest(log, `r${i}`, { status: 200 });
    }
    expect(log.entries).toHaveLength(NETWORK_ENTRIES_PER_TAB_MAX);
    // Scrolling back is useless if it drops what just happened.
    expect(log.entries[log.entries.length - 1].id).toBe(
      `r${NETWORK_ENTRIES_PER_TAB_MAX + 119}`,
    );
  });

  it("one busy tab cannot evict another's history", () => {
    const busy = createTabNetworkLog(1);
    const quiet = createTabNetworkLog(2);
    completeRequest(
      quiet,
      "important",
      { status: 500 },
      { tabId: 2, url: "https://api.test/boom", method: "GET", source: "cdp" },
    );

    for (let i = 0; i < NETWORK_ENTRIES_PER_TAB_MAX * 2; i++) {
      beginRequest(busy, started(`n${i}`));
      completeRequest(busy, `n${i}`, { status: 200 });
    }

    expect(quiet.entries).toHaveLength(1);
    expect(quiet.entries[0].id).toBe("important");
  });

  it("never reports a negative duration", () => {
    const log = createTabNetworkLog(1);
    beginRequest(log, started("skew", { startedAt: 5_000 }));
    const done = completeRequest(log, "skew", { finishedAt: 4_000 });
    expect(done?.durationMs).toBe(0);
  });
});

describe("header + size helpers", () => {
  it("flattens webRequest array headers and CDP string headers alike", () => {
    expect(flattenHeaders({ "Content-Type": ["application/json"] })).toEqual({
      "content-type": "application/json",
    });
    expect(flattenHeaders({ "Content-Type": "text/html" })).toEqual({
      "content-type": "text/html",
    });
    expect(flattenHeaders(undefined)).toBeUndefined();
  });

  it("treats a missing content-length as UNKNOWN, not zero", () => {
    // Chunked and compressed responses have no content-length; reporting 0 would
    // be a lie the UI would render as a real measurement.
    expect(sizeFromHeaders({})).toBeUndefined();
    expect(sizeFromHeaders(undefined)).toBeUndefined();
    expect(sizeFromHeaders({ "content-length": "not-a-number" })).toBeUndefined();
    expect(sizeFromHeaders({ "content-length": "0" })).toBe(0);
    expect(sizeFromHeaders({ "content-length": "2048" })).toBe(2048);
  });
});

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
