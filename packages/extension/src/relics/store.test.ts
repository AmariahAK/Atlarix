/**
 * Relics: storage, scope, lifetime, and the note that is a contract.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  deleteSessionRelics,
  getRelic,
  putRelic,
  readRelicNote,
  relicNote,
  relicUrl,
} from "./store";

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
    runtime: { getURL: (p: string) => `chrome-extension://test/${p}` },
  };
});

describe("storing a relic", () => {
  it("round-trips the document", async () => {
    const id = await putRelic("s1", {
      title: "Q3 chart",
      html: "<!doctype html><p>hi</p>",
    });
    const back = await getRelic("s1", id);
    expect(back?.title).toBe("Q3 chart");
    expect(back?.html).toBe("<!doctype html><p>hi</p>");
  });

  it("gives two identical documents two ids", async () => {
    // NOT content-hashed, unlike an attachment. Rebuilding a chart after a
    // correction must not silently overwrite the one already on screen.
    const a = await putRelic("s1", { title: "One", html: "<p>same</p>" });
    const b = await putRelic("s1", { title: "Two", html: "<p>same</p>" });
    expect(a).not.toBe(b);
    expect((await getRelic("s1", a))?.title).toBe("One");
  });
});

describe("scope and lifetime", () => {
  it("cannot be read from another conversation", async () => {
    const id = await putRelic("s1", { title: "Mine", html: "<p>x</p>" });
    expect(await getRelic("s2", id)).toBeNull();
  });

  it("refuses an id that is not one of ours", async () => {
    // Interpolated into a storage key, so a malformed id must not become a
    // lookup for something else.
    expect(await getRelic("s1", "../../atlarix.sessions.v1")).toBeNull();
  });

  it("dies with the conversation that made it", async () => {
    const mine = await putRelic("s1", { title: "A", html: "<p>a</p>" });
    const other = await putRelic("s2", { title: "B", html: "<p>b</p>" });
    await deleteSessionRelics(["s1"]);
    expect(await getRelic("s1", mine)).toBeNull();
    expect(await getRelic("s2", other)).not.toBeNull();
  });
});

/**
 * The note is the ONLY durable trace of a relic — the document is not in the
 * transcript, only this tool result is. So reopening a conversation rebuilds
 * the card from this sentence, which makes the wording a contract.
 */
describe("the note that survives a reload", () => {
  it("round-trips the id and the title", () => {
    const back = readRelicNote(relicNote("abc123", "Q3 revenue chart"));
    expect(back).toEqual({ id: "abc123", title: "Q3 revenue chart" });
  });

  it("tells the model not to repeat the HTML", () => {
    // Without this the document lands in the transcript anyway — which is the
    // entire cost the tool exists to avoid — and is re-sent every round after.
    expect(relicNote("abc", "X")).toMatch(/not repeat its HTML/);
  });

  it("is not confused by an ordinary tool result", () => {
    expect(readRelicNote("Read 400 lines of totals.csv.")).toBeNull();
    expect(readRelicNote("")).toBeNull();
  });

  it("handles a title containing quotes", () => {
    const back = readRelicNote(relicNote("ff", 'The "big" one'));
    expect(back?.title).toBe('The "big" one');
    expect(back?.id).toBe("ff");
  });
});

describe("the viewer's address", () => {
  it("carries the session and the id", () => {
    const url = relicUrl("s1", "abc");
    expect(url).toContain("relic.html");
    expect(url).toContain("session=s1");
    expect(url).toContain("id=abc");
  });
});
