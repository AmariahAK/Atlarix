/**
 * Accuracy: the provider's own tokenizer, instead of `len / 4`.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { CoreMessage } from "../core/client";
import { measureContext, usedTokensFor } from "./budget";
import {
  DEFAULT_CHARS_PER_TOKEN,
  __resetCalibrationCache,
  loadCalibration,
  observe,
  ratioFor,
  saveCalibration,
} from "./calibration";

beforeEach(() => {
  __resetCalibrationCache();
  const store = new Map<string, unknown>();
  const area = {
    async get(key?: string | null) {
      return typeof key === "string" && store.has(key)
        ? { [key]: store.get(key) }
        : {};
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    },
    async remove() {},
    async clear() {
      store.clear();
    },
  };
  (globalThis as Record<string, unknown>).chrome = {
    storage: { local: area, sync: area },
  };
});

describe("learning the ratio", () => {
  it("starts at four characters a token and moves toward what was charged", () => {
    const c = { ratios: {} };
    expect(ratioFor(c, "z-ai/glm-5.3")).toBe(DEFAULT_CHARS_PER_TOKEN);
    // A model that charged 1,000 tokens for 3,000 characters is a 3.0 model.
    observe(c, "z-ai/glm-5.3", 3_000, 1_000);
    expect(ratioFor(c, "z-ai/glm-5.3")).toBeLessThan(4);
    expect(ratioFor(c, "z-ai/glm-5.3")).toBeGreaterThan(3);
  });

  it("converges rather than jumping to the latest turn", () => {
    // One turn is not a sample. A page of Japanese and a page of CSS genuinely
    // tokenize differently, and letting either set the ratio outright makes the
    // bar jump for reasons the user cannot see.
    const c = { ratios: {} };
    for (let i = 0; i < 20; i++) observe(c, "m", 3_000, 1_000);
    expect(ratioFor(c, "m")).toBeCloseTo(3, 1);
  });

  it("keeps a ratio per model, because the lineup is four different tokenizers", () => {
    const c = { ratios: {} };
    for (let i = 0; i < 20; i++) {
      observe(c, "z-ai/glm-5.3", 2_000, 1_000);
      observe(c, "openai/gpt-6-astra", 4_500, 1_000);
    }
    expect(ratioFor(c, "z-ai/glm-5.3")).toBeLessThan(
      ratioFor(c, "openai/gpt-6-astra"),
    );
  });

  it("refuses an impossible ratio rather than learning it", () => {
    // A ratio outside 1–8 is not a language, it is a bug — and a bad ratio is
    // worse than none: it is wrong with confidence, and it persists to disk.
    const c = { ratios: {} };
    observe(c, "m", 1_000_000, 1_000);
    expect(ratioFor(c, "m")).toBe(DEFAULT_CHARS_PER_TOKEN);
    observe(c, "m", 10, 1_000);
    expect(ratioFor(c, "m")).toBe(DEFAULT_CHARS_PER_TOKEN);
  });

  it("ignores a request too small to measure anything", () => {
    // Below a couple of hundred tokens the provider's per-message framing
    // dominates, and the observation says more about the protocol than the text.
    const c = { ratios: {} };
    observe(c, "m", 40, 10);
    expect(ratioFor(c, "m")).toBe(DEFAULT_CHARS_PER_TOKEN);
  });

  it("survives the panel being closed", async () => {
    const c = await loadCalibration();
    for (let i = 0; i < 20; i++) observe(c, "m", 3_000, 1_000);
    await saveCalibration(c);
    __resetCalibrationCache();
    expect(ratioFor(await loadCalibration(), "m")).toBeCloseTo(3, 1);
  });
});

describe("the anchor", () => {
  const history = (n: number): CoreMessage[] =>
    Array.from({ length: n }, (_, i) => ({
      role: "user" as const,
      content: `message ${i} `.repeat(40),
    }));

  it("uses the measured number for what the provider already counted", () => {
    // A MEASURED BASE PLUS A SMALL ESTIMATE. After a turn the provider has said
    // exactly what the conversation cost; only what has been added since is
    // unknown, so the error is bounded by one turn rather than by the whole
    // conversation.
    const out = usedTokensFor({
      messages: history(10),
      overheadTokens: 2_500,
      anchor: { promptTokens: 50_000, messageCount: 10 },
    });
    expect(out.usedTokens).toBe(50_000);
    expect(out.exact).toBe(true);
  });

  it("does not add the overhead twice", () => {
    // `prompt_tokens` already covers the system prompt and the tool schemas.
    // Adding them again would overstate every anchored conversation by ~2,500
    // tokens — and the bar would creep up on its own between messages.
    const anchored = usedTokensFor({
      messages: history(4),
      overheadTokens: 2_500,
      anchor: { promptTokens: 10_000, messageCount: 4 },
    });
    expect(anchored.usedTokens).toBe(10_000);
  });

  it("adds only what arrived after the measurement", () => {
    const out = usedTokensFor({
      messages: history(12),
      overheadTokens: 2_500,
      anchor: { promptTokens: 10_000, messageCount: 10 },
    });
    expect(out.usedTokens).toBeGreaterThan(10_000);
    expect(out.exact).toBe(false);
    // Two messages' worth, not twelve.
    expect(out.usedTokens).toBeLessThan(11_000);
  });

  it("is abandoned when the transcript got shorter than it measured", () => {
    // Compaction rewrote it, or the user edited and rewound. The messages the
    // anchor counted are not the messages that are there, and trusting it would
    // report the pre-compaction size of a conversation that just shrank —
    // leaving the bar full and the compactor firing on every message.
    const out = usedTokensFor({
      messages: history(3),
      overheadTokens: 2_500,
      anchor: { promptTokens: 90_000, messageCount: 10 },
    });
    expect(out.usedTokens).toBeLessThan(90_000);
    expect(out.exact).toBe(false);
  });

  it("falls back cleanly when no turn has happened yet", () => {
    const out = usedTokensFor({
      messages: history(2),
      overheadTokens: 2_500,
      anchor: null,
    });
    expect(out.usedTokens).toBeGreaterThan(2_500);
    expect(out.exact).toBe(false);
  });

  it("drives the bar, so a measured conversation is measured end to end", () => {
    const status = measureContext({
      messages: history(10),
      overheadTokens: 2_500,
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      anchor: { promptTokens: 84_000, messageCount: 10 },
    });
    expect(status?.usedTokens).toBe(84_000);
    expect(status?.exact).toBe(true);
    expect(status?.ratio).toBeCloseTo(0.5);
  });
});

describe("the calibrated estimate", () => {
  it("changes the answer, which is the whole point", () => {
    const messages: CoreMessage[] = [
      { role: "user", content: "x".repeat(330_000) },
    ];
    const at4 = measureContext({
      messages,
      overheadTokens: 0,
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      charsPerToken: 4,
    });
    const atDense = measureContext({
      messages,
      overheadTokens: 0,
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      // Dense CJK really does land near here, and `/4` is not close.
      charsPerToken: 1.5,
    });
    // The same conversation, measured two ways. At 4 it reads as comfortable
    // and nothing happens; at the model's real ratio it is over budget and
    // should already have been compacted. This is the error the provider's own
    // count removes.
    expect(at4?.health).toBe("healthy");
    expect(at4?.willCompact).toBe(false);
    expect(atDense?.willCompact).toBe(true);
  });
});
