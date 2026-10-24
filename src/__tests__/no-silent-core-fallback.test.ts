/**
 * A turn never moves to Atlarix Core unless Core was chosen. A model whose
 * provider had no usable key used to fall back to Core, silently and paid,
 * including when the key was saved but couldn't be read (a busy or changed
 * keychain: 15.11.1 QA E9, where it then failed "Sign in to use Atlarix Core").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron-log", () => ({
  default: { scope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() }), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] }, app: { getPath: () => "/tmp", isPackaged: false } }));
vi.mock("@/ipc/shared/language_model_helpers", () => ({
  getLanguageModelProviders: async () => [
    { id: "openai", name: "OpenAI", type: "cloud", envVarName: "OPENAI_API_KEY" },
    { id: "compass", name: "Atlarix Core", type: "cloud" },
    { id: "my-endpoint", name: "Your endpoint (llm.lan:8000)", type: "custom", apiBaseUrl: "http://llm.lan:8000/v1" },
  ],
}));
vi.mock("@/ipc/shared/provider_api_keys", () => ({ getProviderApiKey: async () => undefined }));
const masterKey = vi.fn(() => "core-key");
vi.mock("@/ipc/shared/compass_constants", async (orig) => ({
  ...((await orig()) as object),
  // A release build: Core is there to fall back to.
  isCompassBuildConfigured: () => true,
  getCompassMasterApiKey: masterKey,
}));
const stored = vi.fn((_id: string) => false);
vi.mock("@/main/settings", async (orig) => ({
  ...((await orig()) as object),
  hasStoredProviderKey: (id: string) => stored(id),
}));

const { getModelClient } = await import("@/ipc/utils/get_model_client");
const { setPinnedProviderKey, isOwnKeyRun } = await import("@/ipc/shared/pinned-provider-key");

const run = (provider: string, settings: Record<string, unknown> = { providerSettings: {} }) =>
  getModelClient({ provider, name: "some-model" } as never, settings as never);

beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
  masterKey.mockClear();
  stored.mockReturnValue(false);
});
afterEach(() => setPinnedProviderKey("openai", null));

describe("a model with no usable key", () => {
  it("fails, saying so, and never reaches the Core client", async () => {
    await expect(run("openai")).rejects.toThrow(
      "No key for OpenAI. Add one with /connect (Settings in the app), or pick another model.",
    );
    expect(masterKey).not.toHaveBeenCalled();
  });

  it("whose saved key can't be read: says that, not 'no key', and never Core", async () => {
    stored.mockReturnValue(true);
    await expect(run("openai")).rejects.toThrow(
      "Can't read the saved key for OpenAI; re-enter it with /connect (Settings in the app).",
    );
    expect(masterKey).not.toHaveBeenCalled();
  });

  it("an endpoint of your own is asked without one (it may take none)", async () => {
    const out = await run("my-endpoint");
    expect(out.modelClient.builtinProviderId).not.toBe("compass");
  });
});

describe("the key an endpoint was started with (dev mode)", () => {
  it("is used even when the stored copy can't be read, and isn't an own-key run", async () => {
    stored.mockReturnValue(true);
    setPinnedProviderKey("openai", "sk-given", { ownKeyRun: false });
    const out = await run("openai");
    expect(out.modelClient.builtinProviderId).toBe("openai");
    expect(isOwnKeyRun()).toBe(false);
  });
});
