/**
 * `create_relic`.
 *
 * The assertions that matter are about what the tool REFUSES to do: it never
 * opens anything, and it never hands the document back to the model.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { MAX_RELIC_BYTES, getRelic, readRelicNote } from "../relics/store";
import { createRelic } from "./relics";

const CTX = { windowId: 1, sessionId: "s1" };

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

describe("making a relic", () => {
  it("stores the document and reports it to the panel", async () => {
    const out = await createRelic(
      { title: "Q3 chart", html: "<!doctype html><p>hi</p>" },
      CTX,
    );
    expect(out.relic?.title).toBe("Q3 chart");
    const stored = await getRelic("s1", out.relic!.id);
    expect(stored?.html).toBe("<!doctype html><p>hi</p>");
  });

  it("never returns the HTML to the model", async () => {
    // THE WHOLE COST THIS TOOL EXISTS TO AVOID. Echoing the document back puts
    // it in the transcript, where it is then re-sent on every later round —
    // which is the thing a long code block in the chat already does.
    const html = "<!doctype html><style>p{color:red}</style><p>secret</p>";
    const out = await createRelic({ title: "X", html }, CTX);
    expect(out.content).not.toContain("doctype");
    expect(out.content).not.toContain("secret");
  });

  it("carries the id in the result, because that is the only durable trace", async () => {
    const out = await createRelic({ title: "X", html: "<p>a</p>" }, CTX);
    expect(readRelicNote(out.content)?.id).toBe(out.relic?.id);
  });

  it("gives an untitled relic a name rather than a blank card", async () => {
    const out = await createRelic({ html: "<p>a</p>" }, CTX);
    expect(out.relic?.title).toBe("Untitled relic");
  });
});

describe("what it refuses", () => {
  it("saves nothing when the html is empty", async () => {
    const out = await createRelic({ title: "X", html: "   " }, CTX);
    expect(out.relic).toBeUndefined();
    expect(out.content).toMatch(/empty/);
  });

  it("refuses one too large, and says what to do about it", async () => {
    // The refusal names the fix, so the model's next attempt is a smaller relic
    // rather than the same one again.
    const out = await createRelic(
      { title: "X", html: "x".repeat(MAX_RELIC_BYTES + 1) },
      CTX,
    );
    expect(out.relic).toBeUndefined();
    expect(out.content).toMatch(/limit/);
    expect(out.content).toMatch(/split it/);
  });

  it("measures BYTES, not characters", async () => {
    // A document of emoji is four bytes a character. Measuring `.length` would
    // let a relic four times over the limit through.
    const out = await createRelic(
      { title: "X", html: "😀".repeat(MAX_RELIC_BYTES / 3) },
      CTX,
    );
    expect(out.relic).toBeUndefined();
  });
});
