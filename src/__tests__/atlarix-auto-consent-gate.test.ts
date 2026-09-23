/**
 * Main refuses to send an Atlarix Auto request until the user has said yes to
 * its data sharing. The picker asks first, but a saved selection or a synced
 * setting could reach dispatch without passing the picker — so the check that
 * matters is here, at dispatch.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() }),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));
vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => "/tmp", isPackaged: false },
}));
vi.mock("@/ipc/shared/language_model_helpers", () => ({
  getLanguageModelProviders: async () => [
    { id: "compass", name: "Atlarix Core", type: "cloud" },
  ],
}));
vi.mock("@/ipc/shared/core_proxy", () => ({
  ATLARIX_SURFACE: "app",
  getCoreProxyBaseUrl: () => "https://proxy.test/v1",
}));
vi.mock("@/ipc/shared/provider_api_keys", () => ({
  getProviderApiKey: async () => undefined,
}));
vi.mock("@/lib/auth/supabase-client", () => ({
  getSession: async () => ({ access_token: "jwt" }),
}));

import { getModelClient } from "@/ipc/utils/get_model_client";
import {
  __resetCoreModelOverridesForTests,
  setCoreAuto,
} from "@/ipc/shared/core-model-override-store";

const AUTO = { provider: "compass", name: "core-auto" } as const;

beforeEach(() => {
  __resetCoreModelOverridesForTests();
  setCoreAuto({ id: "atlarix/auto", label: "Atlarix Auto" });
});

describe("Atlarix Auto consent at dispatch", () => {
  it("refuses without a recorded yes, and says how to give one", async () => {
    await expect(getModelClient(AUTO as never, {} as never)).rejects.toThrow(
      /one-time OK[\s\S]*shared with OpenAI/,
    );
  });

  it("dispatches once the user has accepted", async () => {
    const out = await getModelClient(AUTO as never, {
      atlarixAutoConsentAt: "2026-09-23T10:00:00Z",
    } as never);
    expect(out.modelClient.builtinProviderId).toBe("compass");
  });
});
