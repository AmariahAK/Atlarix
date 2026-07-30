/**
 * Provider dispatch is the one place in this app where a mistake is SILENT.
 *
 * A wrong base URL or the wrong SDK doesn't throw — the request goes somewhere that
 * answers, and the user gets worse results with no error. So the un-hardcoding work
 * (v14.23.0: dispatch on models.dev's `npm` instead of a 20-case switch) needs a
 * table that pins the resolved endpoint + wire format for every provider that used to
 * be hardcoded, asserted against the values that actually shipped.
 *
 * If a change here is intentional, this table is where you say so.
 */

import { describe, expect, it } from "vitest";
import {
  CLOUD_PROVIDERS,
  OPENWEIGHT_PROVIDER_BASE_URLS,
  resolveProviderBaseUrl,
  resolveProviderEnvVarNames,
  resolveProviderNpm,
} from "@/ipc/shared/language_model_constants";
import {
  OPENAI_COMPATIBLE_NPM,
  hasProviderSdkFactory,
  resolveProviderSdkFactory,
  PROVIDER_SDK_FACTORIES,
} from "@/ipc/shared/provider-sdk-factories";

/**
 * What each provider resolved to BEFORE the change (read off the deleted switch
 * cases in `get_model_client.ts` at v14.22.0). `catalogApi` is what models.dev
 * publishes, passed in so the test proves the OVERLAY wins where it must.
 */
const PINS: Array<{
  id: string;
  /** Expected resolved base URL; null = vendor-native (SDK supplies the host). */
  baseUrl: string | null;
  /** models.dev's `api` for this provider, or undefined when it publishes none. */
  catalogApi?: string;
  /** models.dev's `npm`, i.e. what the catalog would choose unpinned. */
  catalogNpm?: string;
  /** Expected wire format after overlay pins are applied. */
  npm: string;
  note?: string;
}> = [
  // ── were `createOpenAICompatible` with a hardcoded URL (the 11 deleted cases) ──
  { id: "togetherai", baseUrl: "https://api.together.xyz/v1", catalogNpm: "@ai-sdk/togetherai", npm: "@ai-sdk/togetherai" },
  { id: "groq", baseUrl: "https://api.groq.com/openai/v1", catalogNpm: "@ai-sdk/groq", npm: "@ai-sdk/groq" },
  { id: "mistral", baseUrl: "https://api.mistral.ai/v1", catalogNpm: "@ai-sdk/mistral", npm: "@ai-sdk/mistral" },
  { id: "perplexity", baseUrl: "https://api.perplexity.ai", catalogNpm: "@ai-sdk/perplexity", npm: "@ai-sdk/perplexity" },
  { id: "cerebras", baseUrl: "https://api.cerebras.ai/v1", catalogNpm: "@ai-sdk/cerebras", npm: "@ai-sdk/cerebras" },
  {
    id: "huggingface",
    baseUrl: "https://router.huggingface.co/v1",
    catalogApi: "https://router.huggingface.co/v1",
    catalogNpm: OPENAI_COMPATIBLE_NPM,
    npm: OPENAI_COMPATIBLE_NPM,
  },
  {
    id: "nvidia_nim",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    catalogApi: "https://integrate.api.nvidia.com/v1",
    catalogNpm: OPENAI_COMPATIBLE_NPM,
    npm: OPENAI_COMPATIBLE_NPM,
  },
  {
    id: "deepseek",
    // The catalog omits `/v1`; the pin keeps the path we shipped.
    baseUrl: "https://api.deepseek.com/v1",
    catalogApi: "https://api.deepseek.com",
    catalogNpm: OPENAI_COMPATIBLE_NPM,
    npm: OPENAI_COMPATIBLE_NPM,
    note: "catalog drops /v1",
  },
  {
    id: "qwen",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    catalogApi: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    catalogNpm: OPENAI_COMPATIBLE_NPM,
    npm: OPENAI_COMPATIBLE_NPM,
  },
  {
    id: "moonshot",
    baseUrl: "https://api.moonshot.ai/v1",
    catalogApi: "https://api.moonshot.ai/v1",
    catalogNpm: OPENAI_COMPATIBLE_NPM,
    npm: OPENAI_COMPATIBLE_NPM,
  },
  {
    id: "minimax",
    // THE important one. models.dev moved MiniMax to the Anthropic wire format at
    // /anthropic/v1. MiniMax-M3 is the model the published Terminal-Bench run used,
    // so this stays OpenAI-compatible at /v1 until that switch is measured.
    baseUrl: "https://api.minimax.io/v1",
    catalogApi: "https://api.minimax.io/anthropic/v1",
    catalogNpm: "@ai-sdk/anthropic",
    npm: OPENAI_COMPATIBLE_NPM,
    note: "catalog would change the WIRE FORMAT",
  },

  // ── first-party vendor SDKs: no base URL, the SDK knows its own host ──
  { id: "openai", baseUrl: null, catalogNpm: "@ai-sdk/openai", npm: "@ai-sdk/openai" },
  { id: "anthropic", baseUrl: null, catalogNpm: "@ai-sdk/anthropic", npm: "@ai-sdk/anthropic" },
  { id: "google", baseUrl: null, catalogNpm: "@ai-sdk/google", npm: "@ai-sdk/google" },
  { id: "xai", baseUrl: null, catalogNpm: "@ai-sdk/xai", npm: "@ai-sdk/xai" },
];

describe("provider dispatch pins — resolved base URL", () => {
  for (const pin of PINS) {
    const label = pin.note ? `${pin.id} (${pin.note})` : pin.id;
    it(`${label} resolves to ${pin.baseUrl ?? "the SDK's own host"}`, () => {
      expect(resolveProviderBaseUrl(pin.id, pin.catalogApi)).toBe(
        pin.baseUrl ?? undefined,
      );
    });
  }

  it("an unpinned provider takes the catalog's URL — that's the whole point", () => {
    expect(
      resolveProviderBaseUrl("some-new-provider", "https://api.example.com/v1"),
    ).toBe("https://api.example.com/v1");
  });

  it("an unpinned provider with no catalog URL resolves to nothing (not a guess)", () => {
    expect(resolveProviderBaseUrl("some-new-provider", undefined)).toBeUndefined();
  });
});

describe("provider dispatch pins — wire format", () => {
  for (const pin of PINS) {
    it(`${pin.id} speaks ${pin.npm}`, () => {
      expect(resolveProviderNpm(pin.id, pin.catalogNpm)).toBe(pin.npm);
    });
  }

  it("MiniMax's overlay pin overrides the catalog rather than following it", () => {
    // Stated as its own test because it is the one pin whose absence would change
    // behaviour silently AND affect a published benchmark number.
    expect(CLOUD_PROVIDERS.minimax?.npm).toBe(OPENAI_COMPATIBLE_NPM);
    expect(resolveProviderNpm("minimax", "@ai-sdk/anthropic")).toBe(
      OPENAI_COMPATIBLE_NPM,
    );
  });

  it("an SDK we don't bundle falls back to the OpenAI-compatible factory", () => {
    // Groq/Mistral/Perplexity/Cerebras/Together name dedicated SDKs we deliberately
    // don't ship; each must still resolve to a working factory via its pinned URL.
    for (const id of ["groq", "mistral", "perplexity", "cerebras", "togetherai"]) {
      const npm = resolveProviderNpm(id, undefined);
      expect(hasProviderSdkFactory(npm)).toBe(false);
      expect(resolveProviderSdkFactory(npm)).toBe(
        PROVIDER_SDK_FACTORIES[OPENAI_COMPATIBLE_NPM],
      );
      expect(resolveProviderBaseUrl(id, undefined)).toBeTruthy();
    }
  });

  it("every provider in the pin table is dispatchable", () => {
    for (const pin of PINS) {
      const npm = resolveProviderNpm(pin.id, pin.catalogNpm);
      const baseUrl = resolveProviderBaseUrl(pin.id, pin.catalogApi);
      // Either a bundled SDK knows the host, or we have a URL to send to.
      expect(hasProviderSdkFactory(npm) || Boolean(baseUrl)).toBe(true);
    }
  });
});

describe("provider env vars", () => {
  it("puts the SDK's own variable first for Google, not the catalog's env[0]", () => {
    // models.dev publishes ["GOOGLE_API_KEY","GOOGLE_GENERATIVE_AI_API_KEY","GEMINI_API_KEY"];
    // taking env[0] (the old behaviour) picked the one the SDK does NOT read.
    const names = resolveProviderEnvVarNames("google", [
      "GOOGLE_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "GEMINI_API_KEY",
    ]);
    expect(names[0]).toBe("GOOGLE_GENERATIVE_AI_API_KEY");
    // ...and the alternatives are still accepted, in the catalog's order.
    expect(names).toContain("GOOGLE_API_KEY");
    expect(names).toContain("GEMINI_API_KEY");
  });

  it("de-duplicates when the curated name is also the catalog's first", () => {
    const names = resolveProviderEnvVarNames("anthropic", ["ANTHROPIC_API_KEY"]);
    expect(names).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("falls back to the catalog list for a provider with no curated name", () => {
    expect(resolveProviderEnvVarNames("some-new-provider", ["NEW_KEY"])).toEqual([
      "NEW_KEY",
    ]);
  });

  it("returns an empty list rather than a bogus name when nothing is known", () => {
    expect(resolveProviderEnvVarNames("some-new-provider", undefined)).toEqual([]);
  });
});

describe("open-weight base URLs stay the single source", () => {
  it("the overlay and the open-weight map agree for every open-weight provider", () => {
    // Two tables carrying a URL for the same provider is exactly how these drift.
    for (const [id, url] of Object.entries(OPENWEIGHT_PROVIDER_BASE_URLS)) {
      const overlayUrl = CLOUD_PROVIDERS[id]?.apiBaseUrl;
      if (overlayUrl) expect(overlayUrl).toBe(url);
      expect(resolveProviderBaseUrl(id, "https://wrong.example.com")).toBe(url);
    }
  });
});
