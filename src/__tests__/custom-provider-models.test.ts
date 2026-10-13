/**
 * QA (app) #25: a provider the user added for a keyless endpoint (Ollama's
 * /v1) listed no models — "ensure your API key is saved" — and you typed the
 * model id by hand. Its endpoint's own list is read, with no key needed.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchCustomProviderModels } from "@/lib/provider_model_fetchers";

afterEach(() => vi.unstubAllGlobals());

describe("a provider you added", () => {
  it("lists its endpoint's models without a key", async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ object: "list", data: [{ id: "qwen2.5:3b" }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const models = await fetchCustomProviderModels("custom::qa-ollama-v1-test", "http://127.0.0.1:11434/v1/");
    expect(models.map((m) => m.apiName)).toEqual(["qwen2.5:3b"]);
    expect(fetchSpy.mock.calls[0]![0]).toBe("http://127.0.0.1:11434/v1/models");
  });
});
