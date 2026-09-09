import { describe, it, expect, vi } from "vitest";
import { computeAdaptiveStallBudget } from "@/ipc/utils/stream_chunk_tags";

const CEILING = 600_000;
const FLOOR = 180_000;
const opts = { floor: FLOOR, ceiling: CEILING, k: 8 };

describe("computeAdaptiveStallBudget (#7 adaptive stall)", () => {
  it("returns the ceiling until enough samples exist", () => {
    expect(computeAdaptiveStallBudget([], opts)).toBe(CEILING);
    expect(computeAdaptiveStallBudget([1000, 2000, 3000], opts)).toBe(CEILING);
  });

  it("fast, steady cadence tightens to the floor (never below)", () => {
    const fast = Array.from({ length: 20 }, () => 500); // 0.5s gaps
    expect(computeAdaptiveStallBudget(fast, opts)).toBe(FLOOR);
  });

  it("bursty / slow-reasoning cadence keeps a larger budget up to the ceiling", () => {
    const bursty = Array.from({ length: 20 }, () => 40_000); // 40s gaps → 8× = 320s
    const b = computeAdaptiveStallBudget(bursty, opts);
    expect(b).toBeGreaterThan(FLOOR);
    expect(b).toBeLessThanOrEqual(CEILING);
    expect(b).toBe(320_000);
  });

  it("never exceeds the ceiling even for huge gaps", () => {
    const huge = Array.from({ length: 20 }, () => 500_000);
    expect(computeAdaptiveStallBudget(huge, opts)).toBe(CEILING);
  });

  it("ceiling wins when a caller injects a tiny timeout below the floor (test path)", () => {
    // Mirrors unit tests that inject a small stallTimeoutMs — must still stall fast.
    const gaps = Array.from({ length: 20 }, () => 10);
    expect(
      computeAdaptiveStallBudget(gaps, { floor: FLOOR, ceiling: 50, k: 8 }),
    ).toBe(50);
  });
});

vi.mock("@/ipc/utils/findLanguageModel", () => ({
  findLanguageModel: vi.fn(),
}));
import { findLanguageModel } from "@/ipc/utils/findLanguageModel";
import { getMaxTokensWithFloor } from "@/ipc/utils/token_utils";

describe("getMaxTokensWithFloor — reasoning-aware floor (#6)", () => {
  const model = { provider: "openrouter", name: "some/reasoner" } as any;

  it("uses the catalog output limit when present", async () => {
    (findLanguageModel as any).mockResolvedValue({ maxOutputTokens: 64_000 });
    expect(await getMaxTokensWithFloor(model, { reasoningCapable: true })).toBe(
      64_000,
    );
  });

  it("on a catalog miss, reasoning models get a higher floor than the default 8192", async () => {
    (findLanguageModel as any).mockResolvedValue({
      maxOutputTokens: undefined,
    });
    expect(await getMaxTokensWithFloor(model, { reasoningCapable: true })).toBe(
      32_000,
    );
    expect(await getMaxTokensWithFloor(model)).toBe(8_192);
    expect(
      await getMaxTokensWithFloor(model, { reasoningCapable: false }),
    ).toBe(8_192);
  });
});
