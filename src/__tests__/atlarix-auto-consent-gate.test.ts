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

/**
 * The header carries WHICH wording the user said yes to. The proxy offers the
 * free gateways (OpenRouter, Requesty) only on "2"; a yes to the old
 * "shared with OpenAI" wording keeps the OpenAI-only Auto it agreed to.
 */
describe("the consent header names the wording version", () => {
  it("sends nothing without a yes, and the wording version beside it", async () => {
    const { autoRequestHeaders } = await import("@/ipc/utils/get_model_client");
    const { autoConsentAccepted } = await import("@/ipc/shared/compass_constants");
    const none = autoRequestHeaders({} as never);
    expect(none["X-Atlarix-Free-Consent"]).toBeUndefined();
    expect(none["X-Atlarix-Free-Consent-Version"]).toBeUndefined();
    const v1 = autoRequestHeaders({ atlarixAutoConsentAt: "2026-09-23T10:00:00Z" } as never);
    expect(v1["X-Atlarix-Free-Consent"]).toBe("1");
    expect(v1["X-Atlarix-Free-Consent-Version"]).toBe("1");
    // The consent header stays "1" on the new wording too: a proxy from before
    // it only knows "1", and must keep serving a user who said yes.
    const v2 = autoRequestHeaders(autoConsentAccepted() as never);
    expect(v2["X-Atlarix-Free-Consent"]).toBe("1");
    expect(v2["X-Atlarix-Free-Consent-Version"]).toBe("2");
    // A version alone (no yes recorded) is not consent.
    expect(autoRequestHeaders({ atlarixAutoConsentVersion: 2 } as never)["X-Atlarix-Free-Consent"]).toBeUndefined();
  });
});
