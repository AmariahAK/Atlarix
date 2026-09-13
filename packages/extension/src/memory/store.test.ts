/**
 * The memory store.
 *
 * Two things here are worth a test and the rest is a Map with a cap:
 *
 *  1. **Eviction is reported.** A store that silently forgets is worse than one
 *     that refuses, because the user finds out weeks later by being asked
 *     something they already answered. The caller has to be handed what went.
 *  2. **A corrupted store does not take the turn with it.** `storage.local` is
 *     a LevelDB directory any local process running as the user can rewrite,
 *     and these facts are read while BUILDING A PROMPT — so a throw here
 *     surfaces as "the agent stopped working", with no clue why.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { MAX_FACTS, forget, forgetAll, listMemories, remember } from "./store";

const KEY = "atlarix.memory.v1";
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

describe("the cap", () => {
  it("evicts the oldest and SAYS which, rather than forgetting quietly", async () => {
    for (let i = 0; i < MAX_FACTS; i++) {
      await remember(`fact number ${i}`);
    }
    const outcome = await remember("the one that overflows");
    expect(outcome.kind).toBe("saved");
    if (outcome.kind !== "saved") return;
    expect(outcome.evicted?.text).toBe("fact number 0");
    expect(await listMemories()).toHaveLength(MAX_FACTS);
  });

  it("is a prompt budget, so it bounds the store and not just one write", async () => {
    for (let i = 0; i < MAX_FACTS + 10; i++) await remember(`fact ${i}`);
    expect(await listMemories()).toHaveLength(MAX_FACTS);
  });
});

describe("a store rewritten by something else", () => {
  it("drops malformed entries instead of throwing inside a prompt builder", async () => {
    storage.set(KEY, {
      facts: [
        { id: "a", text: "real", createdAt: 1 },
        { id: "b" },
        null,
        "not an object",
        { id: "c", text: "", createdAt: 2 },
      ],
    });
    expect(await listMemories()).toEqual([
      { id: "a", text: "real", createdAt: 1 },
    ]);
  });

  it("returns nothing at all when the value is not even a record", async () => {
    storage.set(KEY, 42);
    expect(await listMemories()).toEqual([]);
  });
});

describe("dedupe is on content, not identity", () => {
  it("treats a re-worded-only-in-whitespace fact as the same one", async () => {
    await remember("Works in Nairobi");
    const again = await remember("   works   in   NAIROBI ");
    expect(again.kind).toBe("duplicate");
    expect(await listMemories()).toHaveLength(1);
  });
});

describe("forget", () => {
  it("reports whether there was anything to forget", async () => {
    const saved = await remember("something");
    if (saved.kind !== "saved") throw new Error("setup failed");
    expect(await forget(saved.memory.id)).toBe(true);
    expect(await forget(saved.memory.id)).toBe(false);
  });

  it("forgetAll leaves a store that still reads cleanly", async () => {
    await remember("a");
    await forgetAll();
    expect(await listMemories()).toEqual([]);
  });
});
