#!/usr/bin/env node
/**
 * Prove that a banned user cannot un-ban themselves.
 *
 * WHY THIS EXISTS
 * ---------------
 * `public.users` has a "Users can update own row" FOR UPDATE policy for
 * `authenticated`. Without a guard, the first thing a banned account could do is
 *
 *     update public.users set banned_at = null where id = auth.uid();
 *
 * The `guard_users_sensitive_columns()` trigger is what stops that. If it ever
 * stops raising, the entire ban design becomes decorative — the proxy would still
 * refuse Core requests, but any client could lift its own ban. That is exactly the
 * kind of failure nothing else would notice, so it gets a runnable check.
 *
 * WHAT IT DOES AND DOES NOT PROVE
 * -------------------------------
 * PROVES: the trigger clause raises for `authenticated`, and that `service_role`
 * still bypasses it (or bans could never be lifted by us either).
 *
 * DOES NOT PROVE: Supabase's real RLS wiring, or that `auth.role()` returns what
 * we assume in production. `auth.role()` / `auth.uid()` are stubbed here so both
 * paths can be driven deterministically. `docs/BAN_RUNBOOK.md` carries the
 * production check.
 *
 * THE TRIGGER IS EXTRACTED FROM THE MIGRATION, NEVER COPIED
 * --------------------------------------------------------
 * An embedded copy would drift from the migration and then verify the wrong
 * thing — which is precisely the failure the migration's own comment warns about
 * for this function (it has been replaced four times, and CREATE OR REPLACE takes
 * a whole body, so working from a stale copy silently drops the team_id /
 * effective_tier membership checks).
 *
 * REQUIREMENTS: a reachable local Postgres and `psql` on PATH. Set PGHOST/PGPORT/
 * PGDATABASE/PGUSER as usual; defaults suit a Homebrew `postgresql@17`. Skips with
 * exit 0 when there is no server, so it never fails a machine that simply has no
 * Postgres — it is a verification tool, not a gate.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MIGRATION = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260819120000_account_bans.sql",
);
const SCHEMA = "atlarix_ban_guard_check";
const UID = "11111111-1111-1111-1111-111111111111";

/**
 * `psql` with no -d connects to a database named after the current user, which
 * usually does not exist on a Homebrew install. Default to `postgres` and let
 * PGDATABASE override, so this works out of the box and stays configurable.
 */
const DB = process.env.PGDATABASE || "postgres";

function psql(sql, { expectFailure = false } = {}) {
  const res = spawnSync(
    "psql",
    ["-d", DB, "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A", "-c", sql],
    { encoding: "utf8" },
  );
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
  if (expectFailure) return { ok: res.status !== 0, out };
  if (res.status !== 0) {
    throw new Error(`psql failed:\n${sql}\n\n${out}`);
  }
  return { ok: true, out };
}

/** Pull the trigger function body out of the migration, verbatim. */
function extractTriggerSql() {
  if (!fs.existsSync(MIGRATION)) {
    throw new Error(`migration not found: ${MIGRATION}`);
  }
  const sql = fs.readFileSync(MIGRATION, "utf8");
  const start = sql.indexOf(
    "CREATE OR REPLACE FUNCTION public.guard_users_sensitive_columns()",
  );
  const end = sql.indexOf(
    "COMMENT ON FUNCTION public.guard_users_sensitive_columns()",
  );
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      "could not locate guard_users_sensitive_columns() in the migration — " +
        "if it was renamed or restructured, update this script rather than " +
        "embedding a copy of the function.",
    );
  }
  const body = sql.slice(start, end);
  if (!body.includes("users.banned_at is managed by Atlarix")) {
    throw new Error(
      "the extracted trigger has no banned_at clause — the guard is missing " +
        "from the migration, so a banned user could un-ban themselves.",
    );
  }
  return body;
}

function serverReachable() {
  const res = spawnSync("psql", ["-d", DB, "-c", "select 1"], { encoding: "utf8" });
  return res.status === 0;
}

function main() {
  try {
    execFileSync("psql", ["--version"], { stdio: "ignore" });
  } catch {
    console.log("[ban-guard] SKIP: psql not on PATH");
    return 0;
  }
  if (!serverReachable()) {
    console.log("[ban-guard] SKIP: no reachable Postgres (set PGHOST/PGPORT/…)");
    return 0;
  }

  const trigger = extractTriggerSql();
  console.log("[ban-guard] extracted guard_users_sensitive_columns() from the migration");

  // Everything lives in a throwaway schema, and `search_path` points the trigger's
  // unqualified `users` / `team_members` references at it.
  psql(`drop schema if exists ${SCHEMA} cascade;`);
  psql(`
    create schema ${SCHEMA};
    set search_path to ${SCHEMA};

    -- Controllable stand-ins for the two Supabase helpers the trigger reads.
    create table _ctx(role text, uid uuid);
    insert into _ctx values ('authenticated', '${UID}');
    create function auth_role() returns text language sql stable as $fn$ select role from ${SCHEMA}._ctx $fn$;
    create function auth_uid() returns uuid language sql stable as $fn$ select uid from ${SCHEMA}._ctx $fn$;

    create table users(
      id uuid primary key, email text not null, plan text default 'free',
      effective_tier text default 'free', team_id uuid, subscription_status text,
      subscription_ends_at timestamptz, lemon_customer_id text,
      lemon_subscription_id text, lemon_variant_id text, customer_portal_url text,
      has_db_studio_legacy boolean default false, banned_at timestamptz);
    create table team_members(team_id uuid, user_id uuid, status text);
    insert into users(id, email, banned_at) values ('${UID}', 'banned@example.test', now());
  `);

  // The trigger calls auth.role()/auth.uid(); map them onto the stubs above.
  psql(`
    set search_path to ${SCHEMA};
    create schema auth;
    create function auth.role() returns text language sql stable as $fn$ select ${SCHEMA}.auth_role() $fn$;
    create function auth.uid() returns uuid language sql stable as $fn$ select ${SCHEMA}.auth_uid() $fn$;
  `);
  psql(`set search_path to ${SCHEMA}, public; ${trigger}
    create trigger users_guard_sensitive_columns
      before update on ${SCHEMA}.users
      for each row execute function public.guard_users_sensitive_columns();`);

  let failures = 0;

  // 1. As `authenticated`: self-un-ban MUST be refused.
  const selfLift = psql(
    `set search_path to ${SCHEMA}, public;
     update ${SCHEMA}.users set banned_at = null where id = ${SCHEMA}.auth_uid();`,
    { expectFailure: true },
  );
  if (selfLift.ok && /banned_at is managed by Atlarix/.test(selfLift.out)) {
    console.log("[ban-guard] PASS  authenticated self-un-ban is refused");
  } else {
    console.error(
      "[ban-guard] FAIL  a banned user could clear their own banned_at:\n" +
        selfLift.out,
    );
    failures += 1;
  }

  // 2. As `service_role`: lifting MUST still work, or we could never unban either.
  psql(`update ${SCHEMA}._ctx set role = 'service_role';`);
  const adminLift = psql(
    `set search_path to ${SCHEMA}, public;
     update ${SCHEMA}.users set banned_at = null where id = '${UID}';
     select coalesce(banned_at::text, 'NULL') from ${SCHEMA}.users where id = '${UID}';`,
  );
  if (adminLift.out.trim().endsWith("NULL")) {
    console.log("[ban-guard] PASS  service_role can lift a ban");
  } else {
    console.error(`[ban-guard] FAIL  service_role could not lift the ban: ${adminLift.out}`);
    failures += 1;
  }

  psql(`drop schema if exists ${SCHEMA} cascade; drop schema if exists auth cascade;`);

  if (failures) {
    console.error(`[ban-guard] ${failures} check(s) FAILED — the ban is decorative.`);
    return 1;
  }
  console.log("[ban-guard] OK (2/2)");
  return 0;
}

try {
  process.exit(main());
} catch (err) {
  console.error(`[ban-guard] ERROR: ${err instanceof Error ? err.message : err}`);
  try {
    spawnSync("psql", ["-d", DB, "-q", "-c", `drop schema if exists ${SCHEMA} cascade; drop schema if exists auth cascade;`]);
  } catch {
    /* best effort */
  }
  process.exit(1);
}
