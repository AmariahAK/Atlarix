import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { makeTestDb, type TestDb } from "../infra/db";
import { makeTempWorkspace, type TempWorkspace } from "../infra/workspace";
import {
  startFakeLlmServer,
  scenario,
  type FakeLlmServer,
} from "../infra/scenario";

/**
 * Phase-0/1 harness probe (docs/TODO.md Tier 4).
 *
 * Validates the load-bearing pieces beneath the agent evals:
 *  (a) the 7.4k-line chat_stream_handlers module graph imports under node
 *      vitest without throwing (registration is lazy),
 *  (b) a REAL better-sqlite3 DB initializes in a temp userData dir via the
 *      embedded SQL migration bundle, and the eval seeders work,
 *  (c) the in-process fake-llm-server serves registered multi-turn scenarios
 *      (native OpenAI tool_call streaming + text + step counting).
 */

let testDb: TestDb;
let ws: TempWorkspace;
let server: FakeLlmServer;

beforeAll(async () => {
  testDb = await makeTestDb();
  ws = makeTempWorkspace({ "src/hello.ts": "export const hello = 1;\n" });
  server = await startFakeLlmServer();
});

afterAll(async () => {
  await server.close();
  ws.cleanup();
  testDb.cleanup();
});

describe("agent-evals harness probe", () => {
  it("(a) imports chat_stream_handlers without throwing", async () => {
    const mod = await import("@/ipc/handlers/chat_stream_handlers");
    expect(mod).toBeTruthy();
  });

  it("(b) initializes a real sqlite DB and seeds provider/model/app rows", async () => {
    const { providerId, modelName } = await testDb.seedTestingProvider(
      server.baseURL,
    );
    const { appId } = await testDb.seedApp({ path: ws.dir });

    const providers = await testDb.db.query.language_model_providers.findMany();
    expect(providers.map((p) => p.id)).toContain(providerId);
    const models = await testDb.db.query.language_models.findMany();
    expect(models.some((m) => m.apiName === modelName)).toBe(true);
    const apps = await testDb.db.query.apps.findMany();
    expect(apps.some((a) => a.id === appId && a.path === ws.dir)).toBe(true);
  });

  it("(c) serves a multi-turn scenario: tool_call step then text step", async () => {
    server.register(
      scenario("probe-roundtrip")
        .toolCall("read_file", { path: "src/hello.ts" })
        .text("All done.")
        .build(),
    );

    const callCompletions = async () => {
      const res = await fetch(`${server.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stream: true,
          messages: [{ role: "user", content: "sc=probe-roundtrip do it" }],
        }),
      });
      expect(res.status).toBe(200);
      return res.text();
    };

    // Step 0: native OpenAI tool_call chunks
    const first = await callCompletions();
    expect(first).toContain('"tool_calls"');
    expect(first).toContain('"read_file"');
    expect(first).toContain('"finish_reason":"tool_calls"');
    expect(first).toContain("data: [DONE]");

    // Step 1: plain text stream
    const second = await callCompletions();
    expect(second).toContain("All done.");
    expect(second).toContain('"finish_reason":"stop"');

    // Step counter + request recording
    expect(server.stepFor("probe-roundtrip")).toBe(2);
    expect(server.requestsFor("probe-roundtrip")).toHaveLength(2);

    // Exhausted script fails loudly (no repeatLast)
    const res = await fetch(`${server.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stream: true,
        messages: [{ role: "user", content: "sc=probe-roundtrip again" }],
      }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.message).toContain("exhausted");
  });

  it("(c2) non-scenario requests keep the legacy tc=/canned behavior", async () => {
    const res = await fetch(`${server.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stream: false,
        messages: [{ role: "user", content: "hello there" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toContain("atlarix-write");
  });
});
