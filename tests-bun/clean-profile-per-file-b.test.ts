/**
 * Each test file has a clean profile and database of its own (tests-bun/preload.ts,
 * with `npm run test:bun`'s --isolate). In one shared database, files saw each
 * other's endpoints and sessions. This file and clean-profile-per-file-a each
 * leave a row, and neither may see the other's, whichever runs first.
 */
import { expect, it } from "bun:test";

it("sees nothing another test file left in its database (b)", async () => {
  const { initializeDatabase } = await import("../src/db");
  const schema = await import("../src/db/schema");
  const db = initializeDatabase();
  db.insert(schema.language_model_providers)
    .values({ id: "clean-profile-marker-b", name: "marker", api_base_url: "http://127.0.0.1:1/v1" })
    .run();
  const ids = db.select({ id: schema.language_model_providers.id }).from(schema.language_model_providers).all().map((r) => r.id);
  expect(ids).toContain("clean-profile-marker-b");
  if (ids.includes("clean-profile-marker-a")) {
    throw new Error("Test files share one database: run the suite with `npm run test:bun` (bun test --isolate).");
  }
});
