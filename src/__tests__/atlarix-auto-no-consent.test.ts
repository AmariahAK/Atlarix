/**
 * Free Atlarix Auto needs no in-app consent (owner, 2026-11-07): what it shares
 * is in the privacy policy and terms, so the first message just runs. The proxy
 * decides free vs paid from the account; the client sends no consent header.
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
  surfaceHeaders: () => ({ "X-Atlarix-Surface": "app" }),
  getCoreProxyBaseUrl: () => "https://proxy.test/v1",
  getPinnedCoreToken: () => null,
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

describe("Atlarix Auto with no consent", () => {
  it("dispatches with nothing recorded — the proxy decides free vs paid", async () => {
    const out = await getModelClient(AUTO as never, {} as never);
    expect(out.modelClient.builtinProviderId).toBe("compass");
  });

  it("sends no consent header, even from settings that still hold an old yes", async () => {
    const { autoRequestHeaders } = await import("@/ipc/utils/get_model_client");
    for (const settings of [{}, { atlarixAutoConsentAt: "2026-09-23T10:00:00Z", atlarixAutoConsentVersion: 2 }]) {
      const h = autoRequestHeaders(settings as never);
      expect(h["X-Atlarix-Free-Consent"]).toBeUndefined();
      expect(h["X-Atlarix-Free-Consent-Version"]).toBeUndefined();
      expect(h["X-Atlarix-Purpose"]).toBe("main");
    }
  });
});
