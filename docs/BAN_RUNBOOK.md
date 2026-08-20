# Banning an account

No admin UI, by design — set the flag in Supabase directly. That is proportionate
while the ban count is near zero, and it keeps the blast radius to one SQL
statement instead of a new authenticated admin role plus its RLS policies.

## What a ban actually does

**Enforced, server-side, non-bypassable:**

- The proxy refuses every Atlarix Core request with **403 `account_banned`**.
  `get_credit_balance` returns `{ok:false, error:'account_banned'}`, `getCreditBalance`
  throws `Banned`, and `server.ts` maps it to 403 at both the pre-flight floor gate
  and the reserve path.
- The client refuses to proceed and offers only Sign out.

**What the client gate actually does — corrected 2026-08-20 after seeing it live.**

The gate sits in front of the **launcher** (`pages/welcome-launcher.tsx`), so a banned
user cannot open a workspace at all: in the client, nothing works, BYOK and local
models included. An earlier version of this document claimed BYOK and local models
kept working and that the UI said so — that was true of the in-turn message
(`accountBannedUserMessage`, shown when a Core request 403s) but never of the launcher
screen, which offers only Sign out. The screen now says "This account has been banned."
rather than naming Core, so it no longer implies a narrower scope than it has.

**What that does NOT change: the proxy is still the only enforcement that counts.**
Atlarix runs offline by design, so the client gate is bypassable by an older build or
no network — a determined banned user with their own API key can still run the app.
That is why the hard stop lives at the proxy, server-side, and why we do not invest in
client-side blocking beyond refusing to proceed. Do not add a BYOK *key* block: it
would be theatre, and it would punish someone whose Supabase read merely failed
(which is why `isUserBanned` fails OPEN).

## Timing

A ban takes effect **within ~3 seconds** on a live session, not at next sign-in:

- `balance-cache.ts` has a 3,000 ms TTL, and every cache miss re-reads through the
  RPC. A rejected read is never cached, so a banned caller re-hits the hard stop on
  every subsequent request.
- The client's realtime subscription on its own `users` row (filtered by email)
  pushes the flip immediately, so a signed-in app reacts without a restart.

## Ban

```sql
-- 1. the flag both the proxy and the client read
update public.users
   set banned_at = now()
 where email = 'someone@example.com';

-- 2. the reason + audit trail (service-role only; never reaches a client)
insert into public.user_bans (user_id, reason, banned_by)
select id, 'tos: abuse report #12', 'amariah'
  from public.users
 where email = 'someone@example.com';
```

## Lift

```sql
update public.users
   set banned_at = null
 where email = 'someone@example.com';

update public.user_bans
   set lifted_at = now(), lifted_by = 'amariah'
 where user_id = (select id from public.users where email = 'someone@example.com')
   and lifted_at is null;
```

No reinstall is needed — the realtime push and the 3s cache TTL restore access on
their own.

## Check

```sql
select u.email, u.banned_at, b.reason, b.banned_at, b.lifted_at
  from public.users u
  left join public.user_bans b on b.user_id = u.id
 where u.email = 'someone@example.com'
 order by b.banned_at desc;
```

## Why the reason is not on `public.users`

`users` has a **"Users can read own data"** SELECT policy, and the app subscribes to
`postgres_changes` UPDATEs on its own row — that payload carries **every column**. A
reason stored there would be delivered straight to the banned user's client. So
`banned_at` lives on `users` (the client has to know it is banned) and the reason
lives in `public.user_bans`, which has RLS on and **no policy for `authenticated`**,
so every non-service-role read is denied.

## Why they can't un-ban themselves

`users` also has **"Users can update own row" FOR UPDATE TO authenticated**. Without a
guard, the first thing a banned user could do is
`update users set banned_at = null where id = auth.uid()`. The
`guard_users_sensitive_columns()` trigger raises on any client-side change to
`banned_at`, alongside the billing columns it already protects. `service_role`
bypasses it, which is what makes the SQL above work.

**If you ever edit that trigger:** copy the body from **the newest migration that
defines it** — currently `20260714130000_pricing_reframe_teardown.sql` — and never
from `supabase/audit/prod_schema.sql`. That audit snapshot is **stale**: it predates
the pricing-reframe teardown, which dropped `public.team_members`, `public.teams`,
`users.team_id` and `users.has_db_studio_legacy`.

This is not a style note. The ban migration's first draft was built from that
snapshot, and it would have **broken every authenticated write to `public.users` in
production**: plpgsql resolves record fields at RUNTIME, so a body referencing
`NEW.has_db_studio_legacy` applies cleanly and then raises
`record "new" has no field "has_db_studio_legacy"` on the first client `UPDATE`.
Caught before applying, by diffing against the migration instead of trusting the
snapshot. The function has now been replaced five times, and `CREATE OR REPLACE`
takes a whole body.

## Verifying the guard actually holds

**Locally, any time:**

```bash
npm run verify:ban-guard
```

It extracts the trigger from the migration (never a copy — see the warning above),
loads it into a throwaway schema on a local Postgres with controllable
`auth.role()` / `auth.uid()` stubs, and asserts both directions: `authenticated`
cannot clear its own `banned_at`, and `service_role` still can. Skips with exit 0
when there is no local Postgres, so it is a tool rather than a gate.

**Its scratch `users` table mirrors the live column set, and must keep doing so.**
The first version invented `team_id`, `has_db_studio_legacy` and a `team_members`
table, so it passed a body that could not run in production — a fixture more
generous than production verifies nothing. With the real columns it fails loudly on
exactly that (`record "new" has no field …`), which is how the stale body above was
caught.

It proves the trigger clause and the `is_admin` bypass. It does **not** prove
Supabase's real RLS wiring, which is what the production check below is for.

**On a real project**, after any change to that trigger. As a **signed-in test
user** (not service role):

```sql
update public.users set banned_at = null where id = auth.uid();
-- expected: ERROR: users.banned_at is managed by Atlarix
```

If that succeeds, the whole design is decorative.
