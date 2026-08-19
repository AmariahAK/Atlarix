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

**NOT blocked, and the UI says so:**

- The user's own API keys (BYOK).
- Local models (Ollama, LM Studio).

That is not an oversight. Atlarix runs offline by design, so a client-side block on
a key the user owns is bypassable by an older build or no network at all. We enforce
what we can actually enforce and claim nothing more. Do not "fix" this by adding a
client-side block on BYOK — it would be theatre, and it would punish someone whose
Supabase read merely failed.

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

**If you ever edit that trigger:** copy the body from
`supabase/audit/prod_schema.sql`, never from the original
`20260602120000_users_billing_column_protection.sql`. It has been replaced four
times, and `CREATE OR REPLACE` takes a whole body — starting from an old copy
silently drops the `team_id` / `effective_tier` membership checks.

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

It proves the trigger clause and the `is_admin` bypass. It does **not** prove
Supabase's real RLS wiring, which is what the production check below is for.

**On a real project**, after any change to that trigger. As a **signed-in test
user** (not service role):

```sql
update public.users set banned_at = null where id = auth.uid();
-- expected: ERROR: users.banned_at is managed by Atlarix
```

If that succeeds, the whole design is decorative.
