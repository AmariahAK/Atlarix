/**
 * A provider the user added can speak the Anthropic Messages API instead of
 * OpenAI's (Bedrock's /anthropic endpoint, gateways, proxies).
 *
 * Each block guards a different quiet failure:
 *   - the key in the wrong header: Bedrock and many gateways take a Bearer
 *     token, Anthropic takes `x-api-key`, and the SDK refuses both at once;
 *   - the key checked by the provider's NAME: a custom provider called
 *     "Anthropic" was probed at api.anthropic.com, not at its own address;
 *   - thinking, /effort and cache markers keyed on the id `"anthropic"`, which
 *     a `custom::` id never is, so they silently did nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateText } from "ai";
import { createModelFromCatalog } from "@/ipc/shared/provider-sdk-factories";
import {
  checkProviderKey,
  detectAnthropicAuth,
  keyProbe,
} from "@/lib/provider-key-check";
import { fetchCustomProviderModels } from "@/lib/provider_model_fetchers";
import {
  __resetCustomProviderFormatsForTests,
  anthropicCatalogModelId,
  rememberCustomProviderFormats,
} from "@/lib/routing/custom-provider-format";
import {
  __resetReasoningRegistryForTests,
  effortChoicesFor,
  registerModelsDevReasoning,
} from "@/lib/routing/model-reasoning-profile";
import {
  detectReasoningCapability,
  resolveCapabilityProviderId,
  resolveDispatchCapabilityProviderId,
  resolveReasoningCatalogModelId,
} from "@/lib/routing/reasoning-detector";
import { resolveCacheMarkerPlacement } from "@/lib/ai/anthropic-cache-breakpoints";

const GW = "custom::my-gateway";
const BEDROCK_HAIKU = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

const MESSAGE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-haiku-4-5",
  content: [{ type: "text", text: "hi" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 3, output_tokens: 1 },
};

afterEach(() => {
  vi.unstubAllGlobals();
  __resetCustomProviderFormatsForTests();
});

describe("the Anthropic SDK factory sends the key the way the endpoint takes it", () => {
  const headersOf = async (authHeader?: "x-api-key" | "bearer") => {
    const seen: Array<{ url: string; headers: Headers }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        seen.push({ url: String(url), headers: new Headers(init?.headers) });
        return new Response(JSON.stringify(MESSAGE), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    await generateText({
      model: createModelFromCatalog({
        providerId: GW,
        modelId: BEDROCK_HAIKU,
        apiKey: "tok-123",
        baseURL: "https://gw.example/anthropic/v1",
        npm: "@ai-sdk/anthropic",
        authHeader,
      }),
      prompt: "hello",
    });
    return seen[0]!;
  };

  it("a Bearer token for an endpoint that takes one, and no x-api-key", async () => {
    const r = await headersOf("bearer");
    expect(r.url).toBe("https://gw.example/anthropic/v1/messages");
    expect(r.headers.get("authorization")).toBe("Bearer tok-123");
    expect(r.headers.get("x-api-key")).toBeNull();
  });

  it("x-api-key otherwise, as Anthropic itself takes it", async () => {
    const r = await headersOf(undefined);
    expect(r.headers.get("x-api-key")).toBe("tok-123");
    expect(r.headers.get("authorization")).toBeNull();
  });
});

describe("a provider you added is checked at its own address, in its own format", () => {
  it("Anthropic format: {base}/models with anthropic-version and the chosen header", () => {
    expect(
      keyProbe(GW, "k", "https://gw.example/anthropic/v1/", { apiFormat: "anthropic", authHeader: "bearer" }),
    ).toEqual({
      url: "https://gw.example/anthropic/v1/models",
      headers: { Authorization: "Bearer k", "anthropic-version": "2023-06-01" },
    });
    expect(keyProbe(GW, "k", "https://gw.example/v1", { apiFormat: "anthropic" })?.headers).toEqual({
      "x-api-key": "k",
      "anthropic-version": "2023-06-01",
    });
  });

  it("one NAMED anthropic is not api.anthropic.com", () => {
    // The CLI used to pass the bare slug: a provider called "Anthropic" → "anthropic".
    expect(keyProbe("anthropic", "k", "http://127.0.0.1:9/v1", { apiFormat: "openai" })?.url).toBe(
      "http://127.0.0.1:9/v1/models",
    );
    expect(keyProbe("custom::anthropic", "k", "http://127.0.0.1:9/v1")?.url).toBe("http://127.0.0.1:9/v1/models");
  });

  it("the built-in Anthropic is unchanged", () => {
    expect(keyProbe("anthropic", "k")?.url).toBe("https://api.anthropic.com/v1/models");
  });
});

describe("detectAnthropicAuth: which header the endpoint takes", () => {
  const server = (accepts: "x-api-key" | "bearer" | "none" | "unlisted") =>
    vi.fn(async (_url: string, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      if (accepts === "unlisted") return new Response("<UnknownOperationException/>", { status: 404 });
      const ok =
        (accepts === "x-api-key" && h.get("x-api-key") === "k") ||
        (accepts === "bearer" && h.get("authorization") === "Bearer k");
      return ok
        ? new Response(JSON.stringify({ data: [{ id: "claude-haiku-4-5" }] }), { status: 200 })
        : new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 });
    });

  it("x-api-key when it works (asked first)", async () => {
    const f = server("x-api-key");
    const r = await detectAnthropicAuth("https://gw.example/v1", "k", f as never);
    expect(r.authHeader).toBe("x-api-key");
    expect(r.check.status).toBe("works");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("Bearer when x-api-key is rejected and Bearer works", async () => {
    const r = await detectAnthropicAuth("https://gw.example/v1", "k", server("bearer") as never);
    expect(r).toMatchObject({ authHeader: "bearer", check: { status: "works" } });
  });

  it("both rejected: x-api-key, and the provider's own words", async () => {
    const r = await detectAnthropicAuth("https://gw.example/v1", "k", server("none") as never);
    expect(r.authHeader).toBe("x-api-key");
    expect(r.check).toMatchObject({ status: "rejected", detail: "invalid x-api-key" });
  });

  it("an endpoint that lists no models (Bedrock): unchecked, not rejected", async () => {
    const r = await detectAnthropicAuth("https://gw.example/v1", "k", server("unlisted") as never);
    expect(r.check.status).toBe("unchecked");
  });

  it("checkProviderKey reads the Anthropic list shape", async () => {
    const probe = keyProbe(GW, "k", "https://gw.example/v1", { apiFormat: "anthropic" });
    expect(await checkProviderKey(probe, "k", server("x-api-key") as never)).toEqual({
      status: "works",
      detail: "1 models",
    });
  });
});

describe("the model list of an Anthropic-format endpoint", () => {
  it("reads {base}/models with its headers, and keeps display names", async () => {
    const f = vi.fn(async (_url: URL | string, _init?: RequestInit) =>
      new Response(
        JSON.stringify({ data: [{ id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5", max_input_tokens: 200000 }], has_more: false }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", f);
    const models = await fetchCustomProviderModels("custom::list-test", "https://gw.example/v1/", "k", {
      apiFormat: "anthropic",
      authHeader: "bearer",
    });
    expect(models.map((m) => [m.apiName, m.displayName, m.contextWindow])).toEqual([
      ["claude-haiku-4-5", "Claude Haiku 4.5", 200000],
    ]);
    const url = new URL(String(f.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe("https://gw.example/v1/models");
    expect(new Headers(f.mock.calls[0]![1]?.headers).get("authorization")).toBe("Bearer k");
  });
});

describe("Bedrock model ids name Anthropic's catalog row", () => {
  it.each([
    [BEDROCK_HAIKU, "claude-haiku-4-5-20251001"],
    ["global.anthropic.claude-sonnet-4-6", "claude-sonnet-4-6"],
    ["anthropic.claude-opus-4-6-v1", "claude-opus-4-6"],
    ["claude-haiku-4-5", "claude-haiku-4-5"],
  ])("%s → %s", (raw, id) => {
    expect(anthropicCatalogModelId(raw)).toBe(id);
  });
});

describe("thinking, /effort and cache markers reach an Anthropic-format provider", () => {
  beforeEach(() => {
    __resetReasoningRegistryForTests();
    registerModelsDevReasoning([
      {
        providerId: "anthropic",
        modelId: "claude-haiku-4-5-20251001",
        profile: { reasoning: true, options: [{ type: "budget_tokens" }] },
        supportsTemperature: true,
      },
    ] as never);
    rememberCustomProviderFormats([
      { id: GW, apiFormat: "anthropic" },
      { id: "custom::plain", apiFormat: undefined },
    ]);
  });

  const model = { provider: GW, name: BEDROCK_HAIKU } as never;

  it("capability lookups resolve to Anthropic's row", () => {
    expect(resolveCapabilityProviderId(model)).toBe("anthropic");
    expect(resolveDispatchCapabilityProviderId(model, GW)).toBe("anthropic");
    expect(resolveReasoningCatalogModelId(model)).toBe("claude-haiku-4-5-20251001");
    expect(effortChoicesFor("anthropic", "claude-haiku-4-5-20251001")).not.toBeNull();
  });

  it("extended thinking is requested in Anthropic's shape", () => {
    expect(detectReasoningCapability("claude-haiku-4-5-20251001", GW).useAnthropicThinking).toBe(true);
  });

  it("Claude gets Anthropic's message-level cache markers", () => {
    expect(resolveCacheMarkerPlacement(GW, BEDROCK_HAIKU)).toBe("message");
  });

  it("an OpenAI-format provider you added is unchanged", () => {
    expect(resolveCapabilityProviderId({ provider: "custom::plain", name: "claude-haiku-4-5" } as never)).toBe(
      "custom::plain",
    );
    expect(detectReasoningCapability("claude-haiku-4-5-20251001", "custom::plain").useAnthropicThinking).toBe(false);
    expect(resolveCacheMarkerPlacement("custom::plain", "claude-haiku-4-5")).toBe("content");
  });
});
