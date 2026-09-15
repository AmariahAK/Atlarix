/**
 * The attachment store, and the paging that replaced truncation.
 *
 * The assertions worth having here are about the two things that used to go
 * wrong silently: a file being quietly shortened, and a conversation's data
 * outliving the conversation. Both are invisible from the panel.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_LINES,
  MAX_PAGE_CHARS,
  MAX_PAGE_LINES,
  attachmentId,
  deleteSessionAttachments,
  getAttachment,
  listAttachments,
  pageOf,
  putAttachment,
} from "./store";

/** The house fake: a Map-backed `chrome.storage`, assigned to `globalThis`. */
beforeEach(() => {
  const data = new Map<string, unknown>();
  const area = {
    get: async (keys: string | string[] | null) => {
      if (keys === null) return Object.fromEntries(data);
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (data.has(k)) out[k] = data.get(k);
      return out;
    },
    set: async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) data.set(k, v);
    },
    remove: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
    clear: async () => data.clear(),
  };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local: area, sync: area },
  };
});

describe("ids", () => {
  it("are the content, so the same file stores once", async () => {
    const a = await putAttachment("s1", { name: "a.txt", type: "t", body: "hi" });
    const b = await putAttachment("s1", { name: "a.txt", type: "t", body: "hi" });
    expect(a).toBe(b);
    expect(await listAttachments("s1")).toHaveLength(1);
  });

  it("differ for different content", async () => {
    expect(await attachmentId("one")).not.toBe(await attachmentId("two"));
  });
});

describe("scope", () => {
  it("does not let one conversation read another's file", async () => {
    // The security property. `sessionId` is injected by the harness and is not
    // a tool parameter, so no text on a page can widen this.
    const id = await putAttachment("s1", {
      name: "secret.txt",
      type: "t",
      body: "private",
    });
    expect(await getAttachment("s1", id)).not.toBeNull();
    expect(await getAttachment("s2", id)).toBeNull();
  });

  it("refuses an id that is not one of ours", async () => {
    // The id is interpolated into a storage key, so a malformed one must not
    // become a lookup for something else.
    expect(await getAttachment("s1", "../../atlarix.sessions.v1")).toBeNull();
    expect(await getAttachment("s1", "")).toBeNull();
  });
});

describe("cleanup", () => {
  it("drops a conversation's files and leaves the others alone", async () => {
    await putAttachment("s1", { name: "a", type: "t", body: "a" });
    await putAttachment("s1", { name: "b", type: "t", body: "b" });
    await putAttachment("s2", { name: "c", type: "t", body: "c" });

    await deleteSessionAttachments(["s1"]);

    expect(await listAttachments("s1")).toEqual([]);
    expect(await listAttachments("s2")).toHaveLength(1);
  });

  it("does nothing, loudly or otherwise, for an empty list", async () => {
    await putAttachment("s1", { name: "a", type: "t", body: "a" });
    await deleteSessionAttachments([]);
    expect(await listAttachments("s1")).toHaveLength(1);
  });
});

describe("paging", () => {
  const lines = (n: number) =>
    Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

  it("reaches the last line of a file far past any old cap", () => {
    // The whole point. 200,000 characters used to be where a file stopped
    // existing; now it is roughly page 8 of 25.
    const body = lines(50_000);
    let at = 1;
    let pages = 0;
    let last = "";
    for (;;) {
      const page = pageOf(body, at, DEFAULT_PAGE_LINES);
      pages += 1;
      last = page.text;
      if (!page.hasMore) break;
      at = page.endLine + 1;
      expect(pages).toBeLessThan(100); // a loop that never ends is the other bug
    }
    expect(last.endsWith("line 50000")).toBe(true);
  });

  it("reports totals and the end honestly", () => {
    const page = pageOf(lines(10), 1, 4);
    expect(page).toEqual({
      text: "line 1\nline 2\nline 3\nline 4",
      startLine: 1,
      endLine: 4,
      totalLines: 10,
      hasMore: true,
    });
    expect(pageOf(lines(10), 9, 4).hasMore).toBe(false);
  });

  it("clamps a silly limit rather than returning the file", () => {
    expect(pageOf(lines(50_000), 1, 1_000_000).endLine).toBe(MAX_PAGE_LINES);
  });

  it("stops early on a file of very long lines", () => {
    // A minified bundle is one line of two megabytes. A page bounded only by
    // lines would hand over the whole file as "one page", which is the thing
    // paging exists to prevent.
    const body = Array.from({ length: 10 }, () => "x".repeat(80_000)).join("\n");
    const page = pageOf(body, 1, 2_000);
    expect(page.text.length).toBeLessThanOrEqual(MAX_PAGE_CHARS + 80_000);
    expect(page.hasMore).toBe(true);
  });

  it("always makes progress, even on one line longer than the ceiling", () => {
    // Without the `out.length > 0` guard this returns an empty page forever and
    // the model loops asking for the same offset.
    const page = pageOf("y".repeat(MAX_PAGE_CHARS * 2), 1, 2_000);
    expect(page.text.length).toBeGreaterThan(0);
    expect(page.hasMore).toBe(false);
  });

  it("survives nonsense offsets", () => {
    expect(pageOf(lines(5), 0, 2).startLine).toBe(1);
    expect(pageOf(lines(5), -7, 2).startLine).toBe(1);
    expect(pageOf(lines(5), 900, 2).startLine).toBe(5);
  });
});
