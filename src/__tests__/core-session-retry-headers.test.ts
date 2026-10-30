/**
 * `X-Atlarix-Session` and `X-Atlarix-Retry` on Atlarix Core requests (contract
 * with ai-34/ai-dd, 2026-10-29).
 *
 * Session: an opaque 32-hex id per chat, the same on every Core request of the
 * chat (main turn, sub-agents, title, compaction), new for another chat, never
 * readable, and the cloud run's own value when it hands one in.
 * Retry: "1" on the FIRST request of a turn the user asked for again, never on
 * the requests after it, and absent otherwise.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { seen, TMP } = vi.hoisted(() => ({
  seen: [] as Headers[],
  TMP: require("node:path").join(require("node:os").tmpdir(), `ai47-session-${process.pid}`),
}));

vi.mock("electron-log", () => ({
  default: { scope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() }), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] }, app: { getPath: () => "/tmp", isPackaged: false } }));
vi.mock("@/paths/paths", () => ({ getUserDataPath: () => TMP }));
vi.mock("@/ipc/shared/language_model_helpers", () => ({
  getLanguageModelProviders: async () => [{ id: "compass", name: "Atlarix Core", type: "cloud" }],
}));
vi.mock("@/ipc/shared/core_proxy", () => ({
  surfaceHeaders: () => ({ "X-Atlarix-Surface": "app" }),
  getCoreProxyBaseUrl: () => "https://proxy.test/v1",
  getPinnedCoreToken: () => null,
  coreProxyFetch: async (_url: string, init?: RequestInit) => {
    seen.push(new Headers(init?.headers));
    return new Response(
      JSON.stringify({
        id: "x",
        object: "chat.completion",
        created: 0,
        model: "m",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  },
}));
vi.mock("@/ipc/shared/provider_api_keys", () => ({ getProviderApiKey: async () => undefined }));
vi.mock("@/lib/auth/supabase-client", () => ({ getSession: async () => ({ access_token: "jwt" }) }));

import { getModelClient } from "@/ipc/utils/get_model_client";
import { __resetCoreModelOverridesForTests, setCoreModelOverrides } from "@/ipc/shared/core-model-override-store";
import { __setCoreSessionSecretForTests, coreSessionId } from "@/lib/core/session-header";

const SONNET = { provider: "compass", name: "core-2" } as const;
const ask = (model: { doGenerate: (o: unknown) => Promise<unknown> }) =>
  model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });

beforeEach(() => {
  seen.length = 0;
  __resetCoreModelOverridesForTests();
  setCoreModelOverrides({ "core-2": "anthropic/claude-sonnet-5-5" });
  __setCoreSessionSecretForTests(null);
  require("node:fs").rmSync(TMP, { recursive: true, force: true });
  delete process.env.ATLARIX_CORE_SESSION;
});

describe("X-Atlarix-Session", () => {
  it("is 32 lowercase hex, stable per chat, different per chat, and not the chat id", () => {
    const a = coreSessionId(41)!;
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(coreSessionId(41)).toBe(a);
    expect(coreSessionId(42)).not.toBe(a);
    // Not a function of the chat id alone: a second install's secret gives another id.
    __setCoreSessionSecretForTests("f".repeat(64));
    expect(coreSessionId(41)).not.toBe(a);
    __setCoreSessionSecretForTests(null);
    expect(coreSessionId(undefined)).toBeNull();
  });

  it("survives a restart: the secret is kept in the shared profile", () => {
    const a = coreSessionId(7);
    __setCoreSessionSecretForTests(null); // a new process (the CLI next to the app)
    expect(coreSessionId(7)).toBe(a);
  });

  it("a cloud run's own value wins when well-formed, and is ignored otherwise", () => {
    expect(coreSessionId(7, { ATLARIX_CORE_SESSION: "0123456789abcdef0123456789abcdef" })).toBe("0123456789abcdef0123456789abcdef");
    expect(coreSessionId(7, { ATLARIX_CORE_SESSION: "NOT-HEX" })).toBe(coreSessionId(7, {}));
  });

  it("is sent on the main turn and on a side call of the same chat, with the same value", async () => {
    const main = await getModelClient(SONNET as never, {} as never, { chatId: 41, purpose: "main" });
    await ask(main.modelClient.model as never);
    const title = await getModelClient(SONNET as never, {} as never, { sessionChatId: 41, purpose: "title" });
    await ask(title.modelClient.model as never);
    expect(seen).toHaveLength(2);
    expect(seen[0].get("x-atlarix-session")).toBe(coreSessionId(41));
    expect(seen[1].get("x-atlarix-session")).toBe(coreSessionId(41));
  });
});

describe("X-Atlarix-Retry", () => {
  it("only on the first request of a user's retry", async () => {
    const out = await getModelClient(SONNET as never, {} as never, { chatId: 41, userRetry: true });
    await ask(out.modelClient.model as never);
    await ask(out.modelClient.model as never); // the next step of the same turn
    expect(seen[0].get("x-atlarix-retry")).toBe("1");
    expect(seen[1].get("x-atlarix-retry")).toBeNull();
  });

  it("never on an ordinary turn", async () => {
    const out = await getModelClient(SONNET as never, {} as never, { chatId: 41 });
    await ask(out.modelClient.model as never);
    expect(seen[0].get("x-atlarix-retry")).toBeNull();
  });
});
