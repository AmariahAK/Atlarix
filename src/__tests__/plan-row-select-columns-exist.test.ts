/**
 * Every column the plan read names must exist in the deployed schema.
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * `banned_at` was added to `PLAN_ROW_SELECT_BASE` so the ban check could ride the
 * plan read "at no extra round-trip". The migration creating that column had not
 * been deployed — and the app ships independently of the database. PostgREST
 * answers an unknown column with an error, so:
 *
 *   [Supabase] getUserPlan error: column users.banned_at does not exist
 *
 * `getUserPlan` caught it and returned `offlinePlanOr('free')`. Every user
 * silently became FREE: a paid account read as free, workspace limits kicked in,
 * and the only evidence was a `warn` behind a fallback that looks deliberate.
 *
 * Naming a column in that query is therefore a BREAKING CHANGE until its
 * migration is deployed, and the failure is quiet. This test makes it loud at
 * build time instead: the select is checked against the audited production
 * schema, which is the closest thing in-repo to what the client will actually
 * talk to.
 *
 * If this fails after you add a column: the fix is NOT to update the audit file.
 * It is to deploy the migration first, or to read the column in its own query
 * that tolerates absence (see `isUserBanned`).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const AUDIT = path.join(process.cwd(), "supabase", "audit", "prod_schema.sql");
const CLIENT = path.join(process.cwd(), "src", "lib", "auth", "supabase-client.ts");

/** Column names on public.users, as the audited production schema declares them. */
function auditedUsersColumns(): Set<string> {
  const sql = fs.readFileSync(AUDIT, "utf8");
  const start = sql.indexOf('CREATE TABLE IF NOT EXISTS "public"."users"');
  expect(start, "public.users not found in the audit schema").toBeGreaterThan(-1);
  const body = sql.slice(start, sql.indexOf(");", start));
  const cols = new Set<string>();
  for (const m of body.matchAll(/^\s{4}"([a-z_]+)"\s/gim)) cols.add(m[1]);
  return cols;
}

/** The column list the app asks PostgREST for. */
function planSelectColumns(): string[] {
  const src = fs.readFileSync(CLIENT, "utf8");
  const m = src.match(/const PLAN_ROW_SELECT_BASE\s*=\s*\n?\s*'([^']+)'/);
  expect(m, "PLAN_ROW_SELECT_BASE not found — was it renamed?").toBeTruthy();
  return m![1].split(",").map((c) => c.trim()).filter(Boolean);
}

describe("PLAN_ROW_SELECT_BASE", () => {
  it("parses to a non-empty column list", () => {
    const cols = planSelectColumns();
    expect(cols.length).toBeGreaterThan(0);
    expect(cols).toContain("plan");
    expect(cols).toContain("effective_tier");
  });

  it("names ONLY columns that exist in the deployed schema", () => {
    const audited = auditedUsersColumns();
    // Sanity: the parse found a real table, not an empty set.
    expect(audited.has("plan")).toBe(true);
    expect(audited.has("email")).toBe(true);

    const missing = planSelectColumns().filter((c) => !audited.has(c));
    expect(
      missing,
      `these columns are selected but absent from supabase/audit/prod_schema.sql: ` +
        `${missing.join(", ")}. A plan read that names an undeployed column makes ` +
        `EVERY user read as free. Deploy the migration first, or query the column ` +
        `separately in a way that tolerates absence.`,
    ).toEqual([]);
  });

  it("also holds for the variant select", () => {
    const src = fs.readFileSync(CLIENT, "utf8");
    const m = src.match(/PLAN_ROW_SELECT_WITH_VARIANT = `\$\{PLAN_ROW_SELECT_BASE\}, ([a-z_]+)`/);
    expect(m, "PLAN_ROW_SELECT_WITH_VARIANT not found").toBeTruthy();
    expect(auditedUsersColumns().has(m![1])).toBe(true);
  });
});
