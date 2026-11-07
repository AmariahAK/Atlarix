/**
 * The CLI header's account part names the provider a turn runs on
 * ("GLM 5.3 · Build · NVIDIA NIM"), never "Your key"; on Atlarix it keeps the
 * plan ("Free", "Pro", "Pay as you go", "Not signed in").
 */
import { describe, expect, it } from "vitest";
import { headerAccount, headerModel, headerModelRef } from "@/cli/tui/header-account";

describe("headerAccount", () => {
  const auto = { provider: "compass", name: "core-auto" };

  it("keeps the plan on Atlarix, word for word", () => {
    expect(headerAccount(auto, "free", null)).toBe("Free");
    expect(headerAccount(auto, "pro", null)).toBe("Pro");
    expect(headerAccount(auto, "payg", null)).toBe("Pay as you go");
    expect(headerAccount(auto, "signed-out", null)).toBe("Not signed in");
    expect(headerAccount(undefined, "free", null)).toBe("Free");
    expect(headerAccount(auto, null, null)).toBeNull();
  });

  it("names the provider of your own key", () => {
    expect(headerAccount({ provider: "nvidia_nim", name: "z-ai/glm-5.3" }, "free", "NVIDIA NIM")).toBe("NVIDIA NIM");
  });

  it("names the local server", () => {
    expect(headerAccount({ provider: "ollama", name: "qwen2.5:3b" }, "pro", "Ollama")).toBe("Ollama");
    expect(headerAccount({ provider: "lmstudio", name: "qwen2.5:3b" }, "pro", "LM Studio")).toBe("LM Studio");
  });

  it("names a --provider-url endpoint, not 'Your key'", () => {
    const ref = { provider: "atlarix-cli-dev-ee0d96d8", name: "fake-model" };
    expect(headerAccount(ref, null, "Your endpoint (127.0.0.1:8080)")).toBe("Your endpoint (127.0.0.1:8080)");
    // Before the label is known: nothing, never a generic word or the id.
    expect(headerAccount(ref, null, null) ?? "").not.toMatch(/your key|atlarix-cli-dev/i);
  });

  it("never says 'Your key' for any provider", () => {
    for (const provider of ["openai", "custom::x", "atlarix-cli-dev", "ollama"]) {
      expect(headerAccount({ provider, name: "m" }, "free", null) ?? "").not.toMatch(/your key|on this computer/i);
    }
  });

  it("before the model list loads, a catalog provider is named from the catalog, never by its id", () => {
    // The first start after the upgrade: no saved name, no list yet (it showed "nvidia_nim").
    const ref = { provider: "nvidia_nim", name: "z-ai/glm-5.3" };
    const line = [headerModel("GLM 5.3", undefined), "Build", headerAccount(ref, "free", undefined)].filter(Boolean).join(" · ");
    expect(line).toBe("GLM 5.3 · Build · NVIDIA NIM");
    expect(headerAccount({ provider: "openrouter", name: "x" }, "free", null)).toBe("OpenRouter");
    expect(headerAccount({ provider: "ollama", name: "qwen2.5:3b" }, "free", null)).toBe("Ollama");
  });

  it("an id the catalog doesn't know, with no saved name: no provider part at all", () => {
    for (const provider of ["custom::my-gateway", "atlarix-cli-dev-ee0d96d8", "some_new_provider"]) {
      const account = headerAccount({ provider, name: "m" }, "free", null);
      expect(account).toBeNull();
      const line = ["m", "Build", account].filter(Boolean).join(" · ");
      expect(line).toBe("m · Build");
      expect(line).not.toContain(provider.replace(/^custom::/, ""));
    }
  });
});

describe("headerModel", () => {
  it("doesn't name a custom endpoint twice", () => {
    const model = headerModel("qwen2.5:3b (My Server)", "My Server");
    const account = headerAccount({ provider: "custom::my-server", name: "qwen2.5:3b" }, "free", "My Server");
    const line = [model, "Build", account].join(" · ");
    expect(line).toBe("qwen2.5:3b · Build · My Server");
    expect(line.split("My Server")).toHaveLength(2);
  });

  it("keeps a model's own bracket", () => {
    expect(headerModel("Nova Micro (US)", "AWS Bedrock")).toBe("Nova Micro (US)");
    expect(headerModel("Atlarix Auto", null)).toBe("Atlarix Auto");
  });
});

describe("headerModelRef", () => {
  const desktop = { provider: "nvidia_nim", name: "z-ai/glm-5.3" };

  it("follows the desktop's model when the CLI never picked one", () => {
    const ref = headerModelRef(undefined, undefined, desktop);
    expect(ref).toEqual(desktop);
    expect(headerAccount(ref, "free", "NVIDIA NIM")).toBe("NVIDIA NIM");
  });

  it("the session's model wins, then the CLI's own choice", () => {
    const cli = { provider: "openai", name: "gpt-5" };
    const session = { provider: "compass", name: "core-auto" };
    expect(headerModelRef(session, cli, desktop)).toEqual(session);
    expect(headerModelRef(undefined, cli, desktop)).toEqual(cli);
    expect(headerModelRef(undefined, undefined, undefined)).toBeUndefined();
  });
});
