/**
 * Conversation storage.
 *
 * The interesting cases are all about what happens to data nobody is watching:
 * an evicted session's transcript, a transcript rewritten by something else,
 * and a conversation that has read enough pages to stop fitting in a request.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { CoreMessage } from "../core/client";
import {
  KEEP_RECENT_TOOL_RESULTS,
  MAX_SESSIONS,
  PRUNE_ABOVE_CHARS,
  deleteSession,
  listSessions,
  loadSession,
  pruneForModel,
  saveSession,
  titleFor,
} from "./store";

let storage: Map<string, unknown>;

beforeEach(() => {
  storage = new Map();
  const area = {
    async get(key?: string | null) {
      return typeof key === "string" && storage.has(key)
        ? { [key]: storage.get(key) }
        : {};
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) storage.set(k, v);
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) storage.delete(k);
    },
    async clear() {
      storage.clear();
    },
  };
  (globalThis as Record<string, unknown>).chrome = {
    storage: { local: area, sync: area },
  };
});

const ask = (text: string): CoreMessage => ({ role: "user", content: text });

describe("round trip", () => {
  it("stores the transcript under its own key, not inside the index", async () => {
    // `storage.local` has no partial write, so one array holding every
    // transcript would rewrite the user's whole history after every round.
    await saveSession("abc", [ask("what is on this page?")]);
    expect(storage.has("atlarix.session.abc.v1")).toBe(true);
    const index = storage.get("atlarix.sessions.v1") as Array<{ id: string }>;
    expect(index).toEqual([
      expect.objectContaining({ id: "abc", title: "what is on this page?" }),
    ]);
    expect(JSON.stringify(index)).not.toContain(
      "what is on this page?".repeat(2),
    );
  });

  it("lists most recently updated first", async () => {
    await saveSession("old", [ask("first")]);
    await new Promise((r) => setTimeout(r, 2));
    await saveSession("new", [ask("second")]);
    expect((await listSessions()).map((s) => s.id)).toEqual(["new", "old"]);
  });

  it("keeps createdAt across a re-save, so the list does not reshuffle", async () => {
    await saveSession("a", [ask("hello")]);
    const created = (await listSessions())[0].createdAt;
    await new Promise((r) => setTimeout(r, 2));
    await saveSession("a", [
      ask("hello"),
      { role: "assistant", content: "hi" },
    ]);
    const after = (await listSessions())[0];
    expect(after.createdAt).toBe(created);
    expect(after.updatedAt).toBeGreaterThan(created);
  });
});

describe("a written title survives the next round", () => {
  it("is not overwritten by the derived one", async () => {
    // `saveSession` runs after EVERY round. Without the flag, a generated title
    // appears for about two seconds and is then replaced by the truncated first
    // message — which reads as a bug in the generator rather than in the store.
    await saveSession("a", [ask("hey what url are we on")]);
    await saveSession("a", [ask("hey what url are we on")], {
      title: "Wikipedia random articles",
    });
    await saveSession("a", [
      ask("hey what url are we on"),
      { role: "assistant", content: "done" },
    ]);
    expect((await listSessions())[0].title).toBe("Wikipedia random articles");
  });

  it("derives a title until one is written", async () => {
    await saveSession("b", [ask("a question")]);
    expect((await listSessions())[0].title).toBe("a question");
  });

  it("lets a later title replace an earlier one", async () => {
    await saveSession("c", [ask("q")], { title: "First" });
    await saveSession("c", [ask("q")], { title: "Second" });
    expect((await listSessions())[0].title).toBe("Second");
  });

  it("ignores a blank title rather than storing an empty row", async () => {
    await saveSession("d", [ask("a question")], { title: "   " });
    expect((await listSessions())[0].title).toBe("a question");
  });
});

describe("eviction", () => {
  it("deletes the evicted transcript, not just its index entry", async () => {
    // An orphaned transcript is invisible and counts against the same quota
    // forever — the sort of leak nobody finds until storage is full.
    for (let i = 0; i < MAX_SESSIONS; i++) {
      await saveSession(`s${i}`, [ask(`q${i}`)]);
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(storage.has("atlarix.session.s0.v1")).toBe(true);

    const { evicted } = await saveSession("overflow", [ask("one too many")]);
    expect(evicted.map((s) => s.id)).toEqual(["s0"]);
    expect(storage.has("atlarix.session.s0.v1")).toBe(false);
    expect(await listSessions()).toHaveLength(MAX_SESSIONS);
  });
});

describe("a store rewritten by something else", () => {
  it("returns an empty conversation rather than throwing inside a render", async () => {
    storage.set("atlarix.session.x.v1", [
      { role: "user", content: "real" },
      { role: "user" },
      { role: "wizard", content: "no" },
      null,
      { role: "tool", content: "missing its id" },
    ]);
    expect(await loadSession("x")).toEqual([{ role: "user", content: "real" }]);
  });

  it("survives an index that is not an array", async () => {
    storage.set("atlarix.sessions.v1", { nope: true });
    expect(await listSessions()).toEqual([]);
  });
});

describe("titles", () => {
  it("comes from the first thing the user asked", () => {
    expect(
      titleFor([
        { role: "assistant", content: "hi" },
        ask("Compare these two pages"),
      ]),
    ).toBe("Compare these two pages");
  });

  it("collapses whitespace and truncates rather than wrapping a list item", () => {
    const t = titleFor([ask(`a${"b".repeat(100)}`)]);
    expect(t).toHaveLength(58);
    expect(t.endsWith("…")).toBe(true);
  });

  it("names an empty conversation something, not an empty string", () => {
    expect(titleFor([])).toBe("New conversation");
  });
});

describe("deleteSession", () => {
  it("removes both halves", async () => {
    await saveSession("gone", [ask("x")]);
    await deleteSession("gone");
    expect(await listSessions()).toEqual([]);
    expect(storage.has("atlarix.session.gone.v1")).toBe(false);
  });
});

describe("pruning for the model", () => {
  const big = (n: number): CoreMessage => ({
    role: "tool",
    tool_call_id: `c${n}`,
    content: "x".repeat(50_000),
  });

  it("does nothing at all to an ordinary conversation", () => {
    const messages = [
      ask("hi"),
      { role: "assistant" as const, content: "hello" },
    ];
    expect(pruneForModel(messages)).toBe(messages);
  });

  it("drops the OLDEST tool results once the transcript is too large", () => {
    const messages: CoreMessage[] = [ask("read everything")];
    for (let i = 0; i < 12; i++) messages.push(big(i));
    expect(
      messages.reduce((n, m) => n + (m.content?.length ?? 0), 0),
    ).toBeGreaterThan(PRUNE_ABOVE_CHARS);

    const pruned = pruneForModel(messages);
    const kept = pruned.filter(
      (m) => m.role === "tool" && (m.content as string).length > 1000,
    );
    expect(kept).toHaveLength(KEEP_RECENT_TOOL_RESULTS);
    // The ones kept are the RECENT ones.
    expect((kept[0] as { tool_call_id: string }).tool_call_id).toBe("c6");
  });

  it("never drops what the user said — only what can be fetched again", () => {
    const messages: CoreMessage[] = [ask("the irreplaceable question")];
    for (let i = 0; i < 12; i++) messages.push(big(i));
    const pruned = pruneForModel(messages);
    expect(pruned[0]).toEqual({
      role: "user",
      content: "the irreplaceable question",
    });
    expect(pruned.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("says the content was dropped instead of truncating it silently", () => {
    // A shortened result with no marker is worse than none: the model reads
    // half a page as the whole page.
    const messages: CoreMessage[] = [ask("q")];
    for (let i = 0; i < 12; i++) messages.push(big(i));
    const dropped = pruneForModel(messages)[1] as { content: string };
    expect(dropped.content).toContain("dropped");
    expect(dropped.content).toContain("call the tool again");
  });

  it("keeps every tool_call_id, so the history still validates", () => {
    // A tool message whose id stopped matching its call is rejected by the
    // provider — pruning must change content and nothing else.
    const messages: CoreMessage[] = [ask("q")];
    for (let i = 0; i < 12; i++) messages.push(big(i));
    const ids = (ms: CoreMessage[]) =>
      ms
        .filter((m) => m.role === "tool")
        .map((m) => (m as { tool_call_id: string }).tool_call_id);
    expect(ids(pruneForModel(messages))).toEqual(ids(messages));
  });
});
