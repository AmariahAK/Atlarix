/**
 * A provider key passed as a file (`atlarix --api-key-file`, e.g. in CI) is held in
 * memory and wins over settings and the environment, so the key the run was
 * given is the one used, without ever writing it to user-settings.json.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron-log", () => ({
  default: { scope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() }), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] }, app: { getPath: () => "/tmp", isPackaged: false } }));
vi.mock("@/ipc/shared/language_model_helpers", () => ({
  getLanguageModelProviders: async () => [{ id: "openai", name: "OpenAI", type: "cloud", envVarName: "OPENAI_API_KEY" }],
}));
vi.mock("@/ipc/shared/provider_api_keys", () => ({ getProviderApiKey: async () => undefined }));
// As in a release build: a keyless provider falls back to Atlarix Core. The
// gate deciding "keyless" is what missed the pinned key.
vi.mock("@/ipc/shared/compass_constants", async (orig) => ({
  ...((await orig()) as object),
  isCompassBuildConfigured: () => true,
}));

import { getModelClient } from "@/ipc/utils/get_model_client";
import { setPinnedProviderKey } from "@/ipc/shared/pinned-provider-key";

const authOf = async (out: Awaited<ReturnType<typeof getModelClient>>) => {
  const headers = (out.modelClient.model as unknown as { config: { headers: () => Record<string, string> } }).config.headers();
  return headers.Authorization ?? headers.authorization;
};

afterEach(() => {
  setPinnedProviderKey("openai", null);
  setPinnedProviderKey("deepseek", null);
});

describe("the pinned provider key", () => {
  it("wins over the key in settings", async () => {
    setPinnedProviderKey("openai", "sk-pinned");
    const out = await getModelClient({ provider: "openai", name: "gpt-4o" } as never, {
      providerSettings: { openai: { apiKey: { value: "sk-settings" } } },
    } as never);
    expect(await authOf(out)).toBe("Bearer sk-pinned");
  });

  it("isn't in the environment the agent's commands inherit", () => {
    setPinnedProviderKey("openai", "sk-pinned-secret");
    expect(JSON.stringify(process.env)).not.toContain("sk-pinned-secret");
  });

  it("without one, settings are used as before", async () => {
    const out = await getModelClient({ provider: "openai", name: "gpt-4o" } as never, {
      providerSettings: { openai: { apiKey: { value: "sk-settings" } } },
    } as never);
    expect(await authOf(out)).toBe("Bearer sk-settings");
  });

  it("with no key anywhere else, it is used: no fallback to Atlarix Core", async () => {
    setPinnedProviderKey("openai", "sk-pinned-only");
    const out = await getModelClient({ provider: "openai", name: "gpt-4o" } as never, { providerSettings: {} } as never);
    expect(out.fellBackToCore).toBe(false);
    expect(await authOf(out)).toBe("Bearer sk-pinned-only");
  });

  it("an own-key run never falls back to Core: a model of another provider is an error", async () => {
    setPinnedProviderKey("deepseek", "sk-for-deepseek");
    await expect(getModelClient({ provider: "openai", name: "gpt-4o" } as never, { providerSettings: {} } as never)).rejects.toThrow(
      /your own API key, but there is none for openai/,
    );
  });
});
