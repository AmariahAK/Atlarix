/**
 * `--provider-url` registers its model on every start. With no unique key to
 * conflict on, each start added the same row again (QA: 4 after 4 starts).
 */
import { beforeAll, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

beforeAll(() => {
  process.env.ATLARIX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "seed-dev-ud-"));
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
});

it("starting with the same local model again adds no second row", async () => {
  const { seedDevProvider } = await import("../src/cli/agent/session");
  let provider = "";
  for (let i = 0; i < 3; i++) ({ provider } = await seedDevProvider({ baseUrl: "http://127.0.0.1:9/v1", model: "fake-model", apiKey: "dev" }));
  await seedDevProvider({ baseUrl: "http://127.0.0.1:9/v1", model: "other-model", apiKey: "dev" });
  const { db } = await import("../src/db");
  const { language_models } = await import("../src/db/schema");
  const { eq } = await import("drizzle-orm");
  // This endpoint's rows (each endpoint has its own provider row since 15.11.1,
  // and other test files in the same run seed theirs).
  const names = db
    .select({ apiName: language_models.apiName })
    .from(language_models)
    .where(eq(language_models.customProviderId, provider))
    .all()
    .map((r) => r.apiName);
  expect(names.filter((n) => n === "fake-model")).toHaveLength(1);
  expect(names.filter((n) => n === "other-model")).toHaveLength(1);
});

it("names a model the catalog knows as the catalog does (15.11.1 QA: replies showed the raw id)", async () => {
  const { seedDevProvider } = await import("../src/cli/agent/session");
  const { db } = await import("../src/db");
  const { language_models } = await import("../src/db/schema");
  const { and, eq } = await import("drizzle-orm");
  const nameOf = async (model: string) => {
    const { provider } = await seedDevProvider({ baseUrl: "http://127.0.0.1:8/v1", model, apiKey: "dev" });
    return db
      .select({ displayName: language_models.displayName })
      .from(language_models)
      .where(and(eq(language_models.apiName, model), eq(language_models.customProviderId, provider)))
      .get()?.displayName;
  };
  expect(await nameOf("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toMatch(/^Claude Haiku 4\.5/);
  // Unknown to the catalog: its id, as before.
  expect(await nameOf("fake-model")).toBe("fake-model");
});
