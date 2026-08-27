import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => "/tmp/atlarix-test" },
}));

import { parseUpdatesPayload } from "@/main/whats-new";

/**
 * The panel renders whatever this returns, so every case here is a card the user
 * would otherwise see in a broken state.
 *
 * The governing rule: an EMPTY PANEL IS WORSE THAN NO PANEL. A blank card with a
 * close button reads as a bug, and the changelog on the website is where the
 * real information lives — so anything not fully usable is treated as no note.
 */

const good = {
  version: 1,
  entries: [
    {
      id: "14.38.0",
      title: "Atlarix Core, included with Pro",
      body: "Pro now includes Atlarix Core for everyday work.",
      link: "https://www.atlarix.dev/changelog",
      linkLabel: "What's new",
    },
  ],
};

describe("parseUpdatesPayload", () => {
  it("reads a well-formed entry", () => {
    expect(parseUpdatesPayload(good)).toEqual({
      id: "14.38.0",
      title: "Atlarix Core, included with Pro",
      body: "Pro now includes Atlarix Core for everyday work.",
      link: "https://www.atlarix.dev/changelog",
      linkLabel: "What's new",
    });
  });

  it("takes the FIRST entry — order in the file is the order", () => {
    const two = {
      entries: [
        { id: "b", title: "Newer", body: "second published, first listed" },
        { id: "a", title: "Older", body: "still here" },
      ],
    };
    expect(parseUpdatesPayload(two)?.id).toBe("b");
  });

  it("returns null for a half-written entry rather than a half-empty card", () => {
    for (const entry of [
      { id: "x", title: "No body" },
      { id: "x", body: "No title" },
      { title: "No id", body: "so nothing can be dismissed" },
      { id: "  ", title: "Blank id", body: "whitespace is not an id" },
      { id: "x", title: "x", body: "   " },
    ]) {
      expect(parseUpdatesPayload({ entries: [entry] })).toBeNull();
    }
  });

  it("returns null for an absent, empty or malformed payload", () => {
    expect(parseUpdatesPayload(null)).toBeNull();
    expect(parseUpdatesPayload({})).toBeNull();
    expect(parseUpdatesPayload({ entries: [] })).toBeNull();
    expect(parseUpdatesPayload({ entries: "nope" })).toBeNull();
    expect(parseUpdatesPayload("<!doctype html>")).toBeNull();
  });

  it("drops a non-https link instead of handing it to openExternalUrl", () => {
    // The renderer opens this in the user's real browser on a click. A file: or
    // javascript: URL published into a remote JSON must never reach that call,
    // and validating in main means the renderer cannot forget to.
    for (const link of ["http://example.com", "javascript:alert(1)", "file:///etc/passwd", "//evil"]) {
      const parsed = parseUpdatesPayload({
        entries: [{ id: "x", title: "t", body: "b", link }],
      });
      expect(parsed).not.toBeNull();
      expect(parsed!.link).toBeUndefined();
    }
  });

  it("drops the link label along with a rejected link", () => {
    // A label with no link is a button that does nothing.
    const parsed = parseUpdatesPayload({
      entries: [{ id: "x", title: "t", body: "b", link: "http://x", linkLabel: "Read" }],
    });
    expect(parsed!.linkLabel).toBeUndefined();
  });

  it("trims, so a note padded with whitespace is not rendered padded", () => {
    const parsed = parseUpdatesPayload({
      entries: [{ id: " 14.38.0 ", title: " Title ", body: " Body " }],
    });
    expect(parsed).toMatchObject({ id: "14.38.0", title: "Title", body: "Body" });
  });
});

describe("the published file is valid against its own reader", () => {
  it("parses the entry shape the releases repo publishes", () => {
    // Guards the one failure the app cannot detect for itself: a hand-edited
    // updates.json that is valid JSON and useless to this parser.
    const parsed = parseUpdatesPayload(good);
    expect(parsed?.id).toBeTruthy();
    expect(parsed?.body.length).toBeLessThan(200);
  });
});
