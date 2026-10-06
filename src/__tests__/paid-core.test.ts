import { describe, it, expect } from "vitest";
import { decidePaidCore } from "@/lib/core/paid-core";

const core = { provider: "compass", name: "core-auto" };
const own = { provider: "openai", name: "gpt-6.1-sol" };

describe("paid Atlarix Core", () => {
  it("is a cloud run's job token, whatever the model", () => {
    expect(
      decidePaidCore({
        model: own,
        hasCloudToken: true,
        signedIn: false,
        isPro: false,
        balanceCents: null,
      }),
    ).toBe(true);
  });
  it("needs an Atlarix model AND a way to pay", () => {
    expect(
      decidePaidCore({
        model: core,
        hasCloudToken: false,
        signedIn: true,
        isPro: true,
        balanceCents: null,
      }),
    ).toBe(true);
    expect(
      decidePaidCore({
        model: core,
        hasCloudToken: false,
        signedIn: true,
        isPro: false,
        balanceCents: 250,
      }),
    ).toBe(true);
    // Free Auto: an Atlarix model with nothing to pay with.
    expect(
      decidePaidCore({
        model: core,
        hasCloudToken: false,
        signedIn: true,
        isPro: false,
        balanceCents: 0,
      }),
    ).toBe(false);
    // Your own key, even on a Pro account.
    expect(
      decidePaidCore({
        model: own,
        hasCloudToken: false,
        signedIn: true,
        isPro: true,
        balanceCents: 500,
      }),
    ).toBe(false);
    expect(
      decidePaidCore({
        model: core,
        hasCloudToken: false,
        signedIn: false,
        isPro: false,
        balanceCents: null,
      }),
    ).toBe(false);
  });
});
