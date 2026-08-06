/**
 * The model picker must not claim a cloud model is "local".
 *
 * REPRODUCTION (owner's, exactly)
 * ------------------------------
 * Pick a cloud model with an API key. Lose the key — which the keystore bug
 * fixed earlier this release did on its own, by deleting any secret it could not
 * decrypt. Reopen the app. The picker read `<model name> (local)`.
 *
 * Why: with no key the provider is no longer configured, so it drops out of
 * `modelsByProviders`; the display lookup misses and falls through to inferring
 * a provider FROM THE MODEL NAME, which returned the literal "local" for any
 * name without a `/`.
 *
 * And it kept streaming the whole time — because the dispatch fallback in
 * `get_model_client` was correctly routing to Atlarix Core. So the app worked
 * and lied about it, which is the worst of the two failure modes: nothing looks
 * broken, so nobody investigates.
 *
 * `selectedModel.provider` was in scope throughout.
 */
import { describe, it, expect } from "vitest";
import { resolveModelDisplayLabel } from "@/lib/resolve-model-display-label";

describe("model label when the provider has no key", () => {
  it("names the real provider, not 'local'", () => {
    // No `modelsByProviders` entry — exactly the post-key-loss state.
    const label = resolveModelDisplayLabel(
      { name: "gpt-5", provider: "openai" },
      { modelsByProviders: {} },
    );
    expect(label).not.toMatch(/local/i);
    expect(label.toLowerCase()).toContain("openai");
  });

  it("holds for any cloud provider with a bare model name", () => {
    for (const [provider, name] of [
      ["anthropic", "claude-sonnet-4"],
      ["groq", "llama-3.3-70b"],
      ["mistral", "mistral-large"],
    ] as const) {
      const label = resolveModelDisplayLabel({ name, provider }, {});
      expect(label).not.toMatch(/local/i);
      expect(label.toLowerCase()).toContain(provider);
    }
  });

  it("still prefers the vendor prefix over the account it came through", () => {
    // The reason the name-inference exists: for an OpenRouter model,
    // "anthropic" says more than "openrouter". That behaviour is preserved.
    const label = resolveModelDisplayLabel(
      { name: "anthropic/claude-sonnet-4", provider: "openrouter" },
      {},
    );
    expect(label.toLowerCase()).toContain("anthropic");
  });

  it("still labels genuinely local providers as themselves", () => {
    // ollama/lmstudio have their own branches and never reached the buggy path,
    // which is why "local" was unreachable-but-wrong rather than merely wrong.
    expect(
      resolveModelDisplayLabel({ name: "qwen3", provider: "ollama" }, {}).toLowerCase(),
    ).toContain("ollama");
    expect(
      resolveModelDisplayLabel({ name: "qwen3", provider: "lmstudio" }, {}).toLowerCase(),
    ).toContain("lmstudio");
  });

  it("prefers a configured provider's own display name when there is one", () => {
    const label = resolveModelDisplayLabel(
      { name: "gpt-5", provider: "openai" },
      {
        modelsByProviders: {
          openai: [
            { apiName: "gpt-5", displayName: "GPT-5", type: "cloud" },
          ] as never,
        },
      },
    );
    expect(label).toBe("GPT-5");
  });
});
