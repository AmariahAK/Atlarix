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
  NETWORK_ORPHAN_BODIES_MAX,
  attachResponseBody,
  beginRequest,
  completeRequest,
  createTabNetworkLog,
  flattenHeaders,
  isFailure,
  sizeFromHeaders,
  type NetworkEntry,
} from "@/lib/browser/network-entry";
import {
  NETWORK_BODY_MAX,
  NETWORK_SENTINEL,
  tryParseNetworkSentinel,
} from "@/lib/browser/network-hook";

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
    // This is the CDP path. A `loadingFinished` with nothing pending is a
    // request that was already in flight when we attached, and all CDP carries
    // is a byte count. Synthesizing one produced rows reading
    // `… GET  undefinedms 14431B` — no URL, no method, no status — sitting in
    // the list as if they were requests you could act on. Measured against
    // youtube.com: 2 such rows in 59.
    const log = createTabNetworkLog(1);
    expect(completeRequest(log, "ghost", { status: 200 })).toBeNull();
    expect(completeRequest(log, "ghost2", { size: 14431 })).toBeNull();
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

  it("reports NO duration for a request it never saw start", () => {
    // 0ms would render as a measurement. The honest answer is "unknown".
    const log = createTabNetworkLog(1);
    const done = completeRequest(
      log,
      "late",
      { status: 200, finishedAt: 9_000 },
      { tabId: 1, url: "https://api.test/late", method: "GET", source: "webrequest" },
    );
    expect(done?.durationMs).toBeUndefined();
  });
});

describe("injected response bodies", () => {
  function withEntry(id: string, url: string, method = "GET") {
    const log = createTabNetworkLog(1);
    beginRequest(log, started(id, { url, method, source: "webrequest" }));
    completeRequest(log, id, { status: 200 });
    return log;
  }

  it("attaches a page-captured body to the matching request", () => {
    const log = withEntry("r1", "https://api.test/users");
    const landed = attachResponseBody(log, {
      method: "get",
      url: "https://api.test/users",
      body: '{"ok":true}',
      truncated: false,
    });
    expect(landed).toBe(true);
    expect(log.entries[0].responseBody).toBe('{"ok":true}');
    expect(log.orphanBodies.size).toBe(0);
  });

  it("gives a polled endpoint distinct bodies rather than copies of the first", () => {
    const log = createTabNetworkLog(1);
    for (const id of ["p1", "p2"]) {
      beginRequest(log, started(id, { url: "https://api.test/poll" }));
      completeRequest(log, id, { status: 200 });
    }
    attachResponseBody(log, {
      method: "GET",
      url: "https://api.test/poll",
      body: "second",
      truncated: false,
    });
    attachResponseBody(log, {
      method: "GET",
      url: "https://api.test/poll",
      body: "first",
      truncated: false,
    });
    // Newest-unfilled-first, so the two bodies land on different rows.
    expect(log.entries.map((e) => e.responseBody)).toEqual(["first", "second"]);
  });

  it("holds a body that wins the race, and completion claims it", () => {
    const log = createTabNetworkLog(1);
    attachResponseBody(log, {
      method: "POST",
      url: "https://api.test/save",
      body: "saved",
      truncated: true,
    });
    expect(log.orphanBodies.size).toBe(1);

    beginRequest(log, started("s1", { url: "https://api.test/save", method: "POST" }));
    const done = completeRequest(log, "s1", { status: 201 });

    expect(done?.responseBody).toBe("saved");
    expect(done?.responseBodyTruncated).toBe(true);
    expect(log.orphanBodies.size).toBe(0);
  });

  it("bounds unclaimed bodies so page traffic cannot leak memory", () => {
    const log = createTabNetworkLog(1);
    for (let i = 0; i < NETWORK_ORPHAN_BODIES_MAX + 25; i++) {
      attachResponseBody(log, {
        method: "GET",
        url: `https://api.test/${i}`,
        body: "x",
        truncated: false,
      });
    }
    expect(log.orphanBodies.size).toBe(NETWORK_ORPHAN_BODIES_MAX);
  });
});

describe("network sentinel", () => {
  it("parses a body record and leaves ordinary console output alone", () => {
    const rec = tryParseNetworkSentinel(
      `${NETWORK_SENTINEL}{"method":"POST","url":"https://api.test/x","status":201,"body":"{}","truncated":false}`,
    );
    expect(rec).toMatchObject({ method: "POST", status: 201, body: "{}" });
    expect(tryParseNetworkSentinel("just a log line")).toBeNull();
    expect(tryParseNetworkSentinel(`${NETWORK_SENTINEL}not json`)).toBeNull();
    // No url means nothing to correlate against — not a usable record.
    expect(tryParseNetworkSentinel(`${NETWORK_SENTINEL}{"method":"GET"}`)).toBeNull();
  });

  it("re-clips an oversized body from the page", () => {
    // The page-side cap runs inside a hostile document, so it is a courtesy.
    const huge = "a".repeat(NETWORK_BODY_MAX + 500);
    const rec = tryParseNetworkSentinel(
      `${NETWORK_SENTINEL}${JSON.stringify({ method: "GET", url: "u", body: huge })}`,
    );
    expect(rec?.body).toHaveLength(NETWORK_BODY_MAX);
    expect(rec?.truncated).toBe(true);
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
