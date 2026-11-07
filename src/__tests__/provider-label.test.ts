/**
 * The provider a person is on, as every surface names it (the CLI header, the
 * editors' pickers and chips, the desktop chip): the catalog's name without its
 * bracketed note, a custom endpoint's name exactly as it was given, and nothing
 * for Atlarix (the caller keeps the plan).
 */
import { describe, expect, it } from "vitest";
import { providerLabel, withoutProviderSuffix } from "@/lib/provider-label";
import { CLOUD_PROVIDERS, LOCAL_PROVIDERS } from "@/ipc/shared/language_model_constants";

const cloud = (id: string) => ({ id, name: CLOUD_PROVIDERS[id]!.displayName, type: "cloud" as const });
const local = (id: string) => ({ id, name: LOCAL_PROVIDERS[id]!.displayName, type: "local" as const });

describe("providerLabel", () => {
  it("names a catalog provider as the catalog does", () => {
    expect(providerLabel(cloud("nvidia_nim"))).toBe("NVIDIA NIM");
    expect(providerLabel(cloud("bedrock"))).toBe("AWS Bedrock");
  });

  it("drops the one bracketed note a catalog name carries", () => {
    expect(providerLabel(cloud("openrouter"))).toBe("OpenRouter");
    expect(providerLabel(cloud("anthropic"))).toBe("Anthropic");
    expect(providerLabel(cloud("xai"))).toBe("Grok");
    expect(providerLabel(cloud("qwen"))).toBe("Qwen");
    expect(providerLabel(cloud("moonshot"))).toBe("Kimi");
  });

  it("leaves no catalog name with a bracket", () => {
    for (const id of Object.keys(CLOUD_PROVIDERS)) {
      if (id === "compass") continue;
      expect(providerLabel(cloud(id))).not.toMatch(/[()]/);
    }
  });

  it("names the local servers", () => {
    expect(providerLabel(local("ollama"))).toBe("Ollama");
    expect(providerLabel(local("lmstudio"))).toBe("LM Studio");
  });

  it("keeps a custom endpoint's name exactly as given", () => {
    expect(providerLabel({ id: "custom::work", name: "Work (EU)", type: "custom" })).toBe("Work (EU)");
    // Known by its id even when the type isn't passed.
    expect(providerLabel({ id: "custom::work", name: "Work (EU)" })).toBe("Work (EU)");
    expect(providerLabel({ id: "atlarix-cli-dev-ee0d96d8", name: "Your endpoint (127.0.0.1:8080)" })).toBe(
      "Your endpoint (127.0.0.1:8080)",
    );
  });

  it("names an unnamed custom endpoint by its id, without the prefix", () => {
    expect(providerLabel({ id: "custom::my-gateway" })).toBe("my-gateway");
    expect(providerLabel({ id: "custom::my-gateway", name: "" })).toBe("my-gateway");
  });

  it("gives nothing for Atlarix, so the caller keeps the plan", () => {
    expect(providerLabel({ id: "compass", name: "Atlarix Core", type: "cloud" })).toBeNull();
    expect(providerLabel({ id: "compass" })).toBeNull();
  });
});

describe("withoutProviderSuffix", () => {
  it("drops a bracket that only repeats the provider", () => {
    expect(withoutProviderSuffix("qwen2.5:3b (My Server)", "My Server")).toBe("qwen2.5:3b");
    expect(withoutProviderSuffix("GPT-5 (openai)", "OpenAI")).toBe("GPT-5");
  });

  it("keeps a bracket that is part of the model's name", () => {
    expect(withoutProviderSuffix("Nova Micro (US)", "AWS Bedrock")).toBe("Nova Micro (US)");
    expect(withoutProviderSuffix("Claude Haiku 4.5", "AWS Bedrock")).toBe("Claude Haiku 4.5");
    expect(withoutProviderSuffix("Auto", null)).toBe("Auto");
  });
});
