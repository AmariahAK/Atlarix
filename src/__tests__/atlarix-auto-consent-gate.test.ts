/**
 * Atlarix Auto dispatches WITHOUT a recorded yes: an account with Pro or credit
 * gets paid Auto, which is never shared, and needs no consent. Only the FREE
 * path shares prompts, and the proxy serves it only with the consent header —
 * which main sends once the user has accepted (see autoRequestHeaders). With
 * no credit and no header the proxy answers 402 consent_required, and the app
 * shows the notice.
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

describe("Atlarix Auto consent at dispatch", () => {
  it("dispatches without a recorded yes — the proxy decides free vs paid", async () => {
    const out = await getModelClient(AUTO as never, {} as never);
    expect(out.modelClient.builtinProviderId).toBe("compass");
  });

  it("dispatches once the user has accepted", async () => {
    const out = await getModelClient(AUTO as never, {
      atlarixAutoConsentAt: "2026-09-23T10:00:00Z",
    } as never);
    expect(out.modelClient.builtinProviderId).toBe("compass");
  });
});
