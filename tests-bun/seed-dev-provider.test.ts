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
  for (let i = 0; i < 3; i++) await seedDevProvider({ baseUrl: "http://127.0.0.1:9/v1", model: "fake-model", apiKey: "dev" });
  await seedDevProvider({ baseUrl: "http://127.0.0.1:9/v1", model: "other-model", apiKey: "dev" });
  const { db } = await import("../src/db");
  const { language_models } = await import("../src/db/schema");
  const names = db.select({ apiName: language_models.apiName }).from(language_models).all().map((r) => r.apiName);
  expect(names.filter((n) => n === "fake-model")).toHaveLength(1);
  expect(names.filter((n) => n === "other-model")).toHaveLength(1);
});
