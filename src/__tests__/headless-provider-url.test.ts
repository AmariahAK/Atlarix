/**
 * `atlarix run --provider-id anthropic --provider-url X` called
 * api.anthropic.com: the address was ignored whenever a provider id was given
 * (QA ai-bc, 2026-10-21). Anthropic at another address is now an
 * Anthropic-format provider there; another built-in id with an address is
 * refused instead of silently going elsewhere.
 */
import { describe, expect, it } from "vitest";
import { headlessProviderSeed } from "@/headless/headless-runner";

const BEDROCK = "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic/v1";

describe("headless provider address", () => {
  it("anthropic with an address seeds an Anthropic-format provider there", () => {
    expect(headlessProviderSeed({ id: "anthropic", baseUrl: BEDROCK, model: "claude-haiku-4-5", authHeader: "bearer" })).toEqual({
      providerId: "atlarix-headless",
      row: {
        id: "atlarix-headless",
        name: "Atlarix Headless",
        api_base_url: BEDROCK,
        api_format: "anthropic",
        auth_header: "bearer",
      },
    });
    expect(headlessProviderSeed({ id: "anthropic", baseUrl: BEDROCK, model: "m" }).row?.auth_header).toBe("x-api-key");
  });

  it("an address alone is an OpenAI-compatible provider; an id alone is the built-in", () => {
    expect(headlessProviderSeed({ baseUrl: "http://127.0.0.1:1234/v1", model: "m" }).row).toEqual({
      id: "atlarix-headless",
      name: "Atlarix Headless",
      api_base_url: "http://127.0.0.1:1234/v1",
    });
    expect(headlessProviderSeed({ id: "anthropic", model: "m" })).toEqual({ providerId: "anthropic" });
  });

  it("another built-in with an address is refused, not sent to its default address", () => {
    expect(() => headlessProviderSeed({ id: "openrouter", baseUrl: "https://example.test/v1", model: "m" })).toThrow(
      /--provider-id anthropic/,
    );
  });
});
