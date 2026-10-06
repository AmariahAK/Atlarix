import { describe, expect, it, vi } from "vitest";

vi.mock("@/ipc/shared/pinned-provider-key", () => ({
  getPinnedProviderKey: () => undefined,
}));
vi.mock("@/ipc/shared/provider_api_keys", () => ({
  getProviderApiKey: async () => undefined,
}));

import {
  hasUsableProviderKey,
  isLoopbackUrl,
} from "@/ipc/utils/get_model_client";

/**
 * A model on the user's own machine needs no key. Observed: `atlarix
 * --provider-url http://localhost:11434/v1 --model qwen3:0.6b` (Ollama, no
 * --api-key) logged "No usable API key … falling back to Atlarix Core" and the
 * run failed "Sign in to use Atlarix Core"; with a placeholder key it worked.
 */
describe("keyless local providers", () => {
  it.each([
    ["http://localhost:11434/v1", true],
    ["http://127.0.0.1:1234/v1", true],
    ["http://[::1]:8080", true],
    ["http://ollama.localhost/v1", true],
    ["https://api.example.com/v1", false],
    ["http://localhost.evil.com/v1", false],
    ["http://10.0.0.5:11434/v1", false],
    [undefined, false],
    ["not a url", false],
  ])("%s → %s", (url, want) => {
    expect(isLoopbackUrl(url as string | undefined)).toBe(want);
  });

  it("a custom provider at a loopback address, or a built-in local one, counts as keyed", async () => {
    const settings = {} as never;
    expect(
      await hasUsableProviderKey("atlarix-headless", settings, {
        id: "atlarix-headless",
        name: "x",
        type: "custom",
        apiBaseUrl: "http://localhost:11434/v1",
      }),
    ).toBe(true);
    expect(
      await hasUsableProviderKey("ollama", settings, {
        id: "ollama",
        name: "Ollama",
        type: "local",
      }),
    ).toBe(true);
    expect(
      await hasUsableProviderKey("acme", settings, {
        id: "acme",
        name: "x",
        type: "custom",
        apiBaseUrl: "https://api.acme.dev/v1",
      }),
    ).toBe(false);
  });
});
