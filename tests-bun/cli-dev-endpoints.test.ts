/**
 * Dev mode (`atlarix --provider-url …`) kept every endpoint in ONE provider row
 * of the shared ~/.atlarix/dev-data. A second CLI or editor started on another
 * endpoint re-pointed it, and the first one's conversation then went to the
 * second endpoint with the second's key (15.11.1, found by QA running two at
 * once). Each endpoint has its own row now; the old shared row keeps the
 * address it holds.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeAnthropic } from "./fixtures/fake-anthropic";

let ws: string;
beforeAll(() => {
  process.env.ATLARIX_USER_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "cli-dev-endpoints-ud-"));
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
  process.env.ATLARIX_SURFACE = "cli";
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "cli-dev-endpoints-ws-"));
  process.chdir(ws);
  process.on("unhandledRejection", () => {});
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MODEL = "claude-haiku-4-5";

describe("dev mode endpoints", () => {
  it("two at once: each process's turn reaches its own endpoint, with its own key", async () => {
    const a = startFakeAnthropic({ key: "key-a", accepts: "x-api-key", reply: "From A." });
    const b = startFakeAnthropic({ key: "key-b", accepts: "x-api-key", reply: "From B." });
    await import("../src/headless/bundled-assets");
    const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
    // A starts, then B starts on its own endpoint (the same profile), then A sends.
    const modelA = await seedDevProvider({ baseUrl: a.url, model: MODEL, apiKey: "key-a", apiFormat: "anthropic" });
    const modelB = await seedDevProvider({ baseUrl: b.url, model: MODEL, apiKey: "key-b", apiFormat: "anthropic" });
    expect(modelA.provider).not.toBe(modelB.provider);

    const turns = (f: ReturnType<typeof startFakeAnthropic>) => f.requests.filter((q) => q.path === "/v1/messages");
    for (const [model, mine, other, key] of [
      [modelA, a, b, "key-a"],
      [modelB, b, a, "key-b"],
    ] as const) {
      const before = { mine: turns(mine).length, other: turns(other).length };
      const s = new AgentSession({ workspaceDir: ws, model });
      await s.start();
      await s.submit("hello");
      for (let i = 0; i < 100 && s.state.busy; i++) await wait(100);
      const sent = turns(mine).slice(before.mine);
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.every((q) => q.headers["x-api-key"] === key)).toBe(true);
      expect(turns(other).length).toBe(before.other);
    }
    a.stop();
    b.stop();
  }, 60_000);

  it("uses the key it was started with when the stored copy can't be read (QA E9)", async () => {
    const f = startFakeAnthropic({ key: "key-given", accepts: "x-api-key", reply: "Given." });
    await import("../src/headless/bundled-assets");
    const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
    const model = await seedDevProvider({ baseUrl: f.url, model: MODEL, apiKey: "key-given", apiFormat: "anthropic" });
    // The app, on the same profile, re-saved the key with its own keychain.
    const { getSettingsFilePath } = await import("../src/main/settings");
    const file = getSettingsFilePath();
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    raw.providerSettings[model.provider].apiKey = { value: "djEwAAAAunreadable", encryptionType: "electron-safe-storage" };
    fs.writeFileSync(file, JSON.stringify(raw));

    const s = new AgentSession({ workspaceDir: ws, model });
    await s.start();
    await s.submit("hello");
    for (let i = 0; i < 100 && s.state.busy; i++) await wait(100);
    const sent = f.requests.filter((q) => q.path === "/v1/messages");
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((q) => q.headers["x-api-key"] === "key-given")).toBe(true);
    expect(s.state.lastError ?? "").not.toMatch(/Core/);
    f.stop();
  }, 60_000);

  it("a model with no key: the turn says so, and nothing goes to Atlarix Core", async () => {
    delete process.env.OPENAI_API_KEY;
    await import("../src/headless/bundled-assets");
    const { AgentSession } = await import("../src/cli/agent/session");
    const s = new AgentSession({ workspaceDir: ws, model: { provider: "openai", name: "gpt-4o-mini" } });
    await s.start();
    await s.submit("hello");
    for (let i = 0; i < 100 && s.state.busy; i++) await wait(100);
    expect(JSON.stringify(s.state.cells) + (s.state.lastError ?? "")).toContain("No key for OpenAI");
    expect(JSON.stringify(s.state.cells) + (s.state.lastError ?? "")).not.toContain("Atlarix Core");
  }, 60_000);

  it("the same endpoint again is the same row", async () => {
    const { seedDevProvider } = await import("../src/cli/agent/session");
    const one = await seedDevProvider({ baseUrl: "http://127.0.0.1:1/v1", model: "m" });
    const two = await seedDevProvider({ baseUrl: "http://127.0.0.1:1/v1/", model: "m" });
    expect(two.provider).toBe(one.provider);
    // Another format at the same address is another endpoint.
    const anth = await seedDevProvider({ baseUrl: "http://127.0.0.1:1/v1", model: "m", apiFormat: "anthropic" });
    expect(anth.provider).not.toBe(one.provider);
  });

  it("the row every endpoint shared before stays the row for its own address", async () => {
    const { initializeDatabase } = await import("../src/db");
    const schema = await import("../src/db/schema");
    const { eq } = await import("drizzle-orm");
    const db = initializeDatabase();
    const legacyUrl = "http://127.0.0.1:2/v1";
    db.insert(schema.language_model_providers)
      .values({ id: "atlarix-cli-dev", name: "Local endpoint (CLI dev)", api_base_url: legacyUrl })
      .onConflictDoUpdate({ target: schema.language_model_providers.id, set: { api_base_url: legacyUrl, api_format: null } })
      .run();
    const { seedDevProvider } = await import("../src/cli/agent/session");
    // Its own address: saved models and switches against it keep working.
    expect((await seedDevProvider({ baseUrl: legacyUrl, model: "m" })).provider).toBe("atlarix-cli-dev");
    // Another address gets its own row, and the old one is not re-pointed.
    expect((await seedDevProvider({ baseUrl: "http://127.0.0.1:3/v1", model: "m" })).provider).not.toBe("atlarix-cli-dev");
    const legacy = db
      .select({ url: schema.language_model_providers.api_base_url })
      .from(schema.language_model_providers)
      .where(eq(schema.language_model_providers.id, "atlarix-cli-dev"))
      .get();
    expect(legacy?.url).toBe(legacyUrl);
  });
});
