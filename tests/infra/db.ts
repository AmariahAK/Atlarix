import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setUserDataDir } from "./user-data-override";

/**
 * Real better-sqlite3 DB in a per-file temp userData dir, initialized through
 * the app's own embedded SQL migration bundle.
 *
 * The `_db` singleton in src/db/index.ts caches the first connection, so call
 * this ONCE per test file (beforeAll) and isolate tests by appId/chatId. The
 * agent-evals vitest project runs files isolated + non-parallel, so each file
 * gets a fresh module registry and thus a fresh singleton.
 */
export async function makeTestDb() {
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "atlarix-eval-userdata-"),
  );
  setUserDataDir(userDataDir);

  const { initializeDatabase } = await import("@/db");
  const db = initializeDatabase();
  const schema = await import("@/db/schema");

  return {
    db,
    schema,
    userDataDir,

    /** Workspace app row pointing at a real temp dir (see makeTempWorkspace). */
    async seedApp(opts: { path: string; name?: string }): Promise<{
      appId: number;
    }> {
      const rows = await db
        .insert(schema.apps)
        .values({ name: opts.name ?? "eval-app", path: opts.path })
        .returning({ id: schema.apps.id });
      return { appId: rows[0].id };
    },

    /**
     * Custom OpenAI-compatible provider routed at the in-process fake server.
     * `getModelClient` resolves custom providers by raw DB id, so settings
     * select it via `selectedModel: { name: modelName, provider: providerId }`.
     */
    async seedTestingProvider(
      baseURL: string,
      opts?: { providerId?: string; modelName?: string },
    ): Promise<{ providerId: string; modelName: string }> {
      const providerId = opts?.providerId ?? "agent-eval-testing";
      const modelName = opts?.modelName ?? "agent-eval-model";
      await db.insert(schema.language_model_providers).values({
        id: providerId,
        name: "Agent Eval Testing",
        api_base_url: baseURL,
      });
      await db.insert(schema.language_models).values({
        displayName: modelName,
        apiName: modelName,
        customProviderId: providerId,
      });
      return { providerId, modelName };
    },

    cleanup() {
      setUserDataDir(null);
      fs.rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

export type TestDb = Awaited<ReturnType<typeof makeTestDb>>;
