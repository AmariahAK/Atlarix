/**
 * Every column the plan read names must exist in the schema history.
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
 * WHY THIS READS MIGRATIONS AND NOT THE AUDIT SNAPSHOT
 * ---------------------------------------------------
 * The first version read `supabase/audit/prod_schema.sql`, and that was wrong
 * twice over:
 *
 *   1. **It is gitignored**, so the test passed on the author's machine and could
 *      only ever fail in CI — which is exactly what it did, on the release run,
 *      with `ENOENT`. A test whose fixture is not in the repo is not a test.
 *   2. **The snapshot is STALE.** Proved the same day: it predates
 *      `20260714130000_pricing_reframe_teardown.sql`, which dropped `team_id` and
 *      `has_db_studio_legacy`. A body copied from it nearly shipped a migration
 *      that would have broken every client write to `public.users`. So it was
 *      never the reliable proxy for production it was described as.
 *
 * The migrations ARE committed, and they are the source of truth for what the
 * schema is — the same conclusion the ban migration arrived at the hard way.
 *
 * HONEST ABOUT WHAT THIS NO LONGER CATCHES
 * ----------------------------------------
 * The original bug was a column that existed **in a migration** but was not
 * **deployed**. Deriving from migrations cannot see that, so this check is
 * strictly weaker than the snapshot pretended to be: it catches a typo, a renamed
 * column, and a column that no migration ever creates — not an undeployed one.
 * The undeployed case is held by two other things, and they are the real defence:
 * the runbook discipline of deploying before shipping the read, and the
 * `isUserBanned` pattern of querying a new column in its own request that
 * tolerates absence. If you want the deployed-schema check back, it has to query
 * a real database, not a file.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const MIGRATIONS = path.join(process.cwd(), "supabase", "migrations");
const CLIENT = path.join(
  process.cwd(),
  "src",
  "lib",
  "auth",
  "supabase-client.ts",
);

/**
 * Column names on `public.users`, replayed from the migrations in deployment
 * order (filenames are timestamps, so lexical order IS deployment order).
 *
 * Line-oriented with a tracked ALTER TABLE target rather than statement-split on
 * `;`, because the early migrations wrap their ALTERs in `DO $$ … $$;` blocks
 * containing semicolons — splitting on those would attribute a column to the
 * wrong table, which is the one mistake that would make this test lie.
 */
function migratedUsersColumns(): Set<string> {
  // `public.users` itself predates the migrations (Supabase creates it), so `id`
  // and `email` appear in no ADD COLUMN. Declared here rather than inferred,
  // because inferring "it must exist since policies reference it" is how a typo
  // gets waved through.
  const cols = new Set<string>(["id", "email"]);

  const files = fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  expect(files.length, "no migrations found").toBeGreaterThan(0);

  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, file), "utf8");
    let targetIsUsers = false;
    for (const raw of sql.split(/\r?\n/)) {
      const line = raw.trim();
      const alter = line.match(
        /^ALTER\s+TABLE\s+(?:ONLY\s+)?(?:public\.)?"?(\w+)"?/i,
      );
      if (alter) targetIsUsers = alter[1].toLowerCase() === "users";
      if (!targetIsUsers) continue;
      for (const m of line.matchAll(
        /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_]+)"?/gi,
      )) {
        cols.add(m[1].toLowerCase());
      }
      for (const m of line.matchAll(
        /DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?([a-z_]+)"?/gi,
      )) {
        cols.delete(m[1].toLowerCase());
      }
    }
  }
  return cols;
}

/**
 * The column list the app asks PostgREST for.
 *
 * QUOTE STYLE MUST NOT MATTER. This read the constant with a single-quote-only
 * pattern, so running the repo's own formatter — which normalises to double quotes —
 * broke both assertions in this file for a reason that has nothing to do with
 * columns, migrations, or the bug this test exists for. Any of the three JS string
 * delimiters is accepted now: the subject is the column list, never how it is
 * spelled. A backtick is included because the constant is a plain string today but
 * its sibling `PLAN_ROW_SELECT_WITH_VARIANT` is already a template literal.
 */
function planSelectColumns(): string[] {
  const src = fs.readFileSync(CLIENT, "utf8");
  const m = src.match(
    /const PLAN_ROW_SELECT_BASE\s*=\s*(?:'([^']+)'|"([^"]+)"|`([^`]+)`)/,
  );
  expect(m, "PLAN_ROW_SELECT_BASE not found — was it renamed?").toBeTruthy();
  const literal = m![1] ?? m![2] ?? m![3]!;
  return literal
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

describe("PLAN_ROW_SELECT_BASE", () => {
  it("parses to a non-empty column list", () => {
    const cols = planSelectColumns();
    expect(cols.length).toBeGreaterThan(0);
    expect(cols).toContain("plan");
    expect(cols).toContain("effective_tier");
  });

  it("replays the migrations into a plausible users table", () => {
    const cols = migratedUsersColumns();
    // Sanity, so a parse that silently matched nothing cannot pass the real
    // assertion below by returning an empty set.
    expect(
      cols.has("plan"),
      "plan missing — the migration replay found nothing",
    ).toBe(true);
    expect(cols.has("effective_tier")).toBe(true);
    expect(cols.has("banned_at")).toBe(true);
    // And the teardown's DROPs must be honoured, or the replay is add-only and
    // would happily approve a column that no longer exists.
    expect(cols.has("team_id"), "team_id was DROPPED by 20260714130000").toBe(
      false,
    );
    expect(cols.has("has_db_studio_legacy")).toBe(false);
  });

  it("names ONLY columns some migration creates", () => {
    const known = migratedUsersColumns();
    const missing = planSelectColumns().filter((c) => !known.has(c));
    expect(
      missing,
      `these columns are selected but no migration creates them: ${missing.join(", ")}. ` +
        `A plan read that names a column the database does not have makes EVERY user ` +
        `read as free. Add the migration AND deploy it first, or query the column ` +
        `separately in a way that tolerates absence (see isUserBanned).`,
    ).toEqual([]);
  });

  it("also holds for the variant select", () => {
    const src = fs.readFileSync(CLIENT, "utf8");
    const m = src.match(
      /PLAN_ROW_SELECT_WITH_VARIANT = `\$\{PLAN_ROW_SELECT_BASE\}, ([a-z_]+)`/,
    );
    expect(m, "PLAN_ROW_SELECT_WITH_VARIANT not found").toBeTruthy();
    expect(migratedUsersColumns().has(m![1])).toBe(true);
  });
});

describe("USER_ROW_SELECT (the one shared read of the account's row)", () => {
  it("names ONLY columns some migration creates", () => {
    // Every reader falls back to its own narrow query if this read fails, so a
    // missing column cannot make anyone free — but it would quietly bring back
    // the ~8 reads per launch this read exists to remove.
    const src = fs.readFileSync(CLIENT, "utf8");
    const m = src.match(/const USER_ROW_SELECT\s*=\s*"([^"]+)"/);
    expect(m, "USER_ROW_SELECT not found — was it renamed?").toBeTruthy();
    const cols = m![1]!.split(",").map((c) => c.trim()).filter(Boolean);
    const known = migratedUsersColumns();
    expect(cols.filter((c) => !known.has(c))).toEqual([]);
  });
});
