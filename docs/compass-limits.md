# Compass token limits

## Run in Supabase SQL Editor

To create **RLS**, the **`compass_tokens`** table, and the RPCs **`get_compass_usage_state`** / **`record_compass_usage`** in one go:

1. Open your Supabase project → **SQL Editor** → New query.
2. Paste the **entire** contents of [`supabase/migrations/20260329120000_compass_tokens.sql`](../supabase/migrations/20260329120000_compass_tokens.sql) and run it once.

The script is idempotent where possible (`CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, policies use fixed names).

**Follow-up (recommended):** Run [`supabase/migrations/20260329131000_compass_tokens_no_direct_writes.sql`](../supabase/migrations/20260329131000_compass_tokens_no_direct_writes.sql) in the same SQL Editor. It adds RLS policies so authenticated clients **cannot** `INSERT`/`UPDATE`/`DELETE` `compass_tokens` directly — only `SELECT` and the `SECURITY DEFINER` RPCs may change usage.

**Prerequisite:** The RPCs read subscription tier from **`public.users`** (`plan` / `effective_tier`). Your project must expose that table and columns to Postgres (same schema the app already uses for billing). If your column names differ, edit the `SELECT ... FROM public.users u WHERE u.id = uid` blocks in both functions before running.

---

## COMPASS TOKEN LIMITS — ADJUSTABLE VALUES

To change token limits per tier, update the DEFAULT values in the Supabase migration
[`supabase/migrations/20260329120000_compass_tokens.sql`](../supabase/migrations/20260329120000_compass_tokens.sql)
(in the `CASE t` branches inside `get_compass_usage_state` and `record_compass_usage`)
and run a targeted UPDATE on existing users:

```sql
UPDATE compass_tokens SET monthly_limit = <new_value> WHERE tier = '<tier>';
```

These values were set conservatively for launch (Month 1-2).
Review after first billing cycle and adjust based on actual usage patterns.

**Monthly reset logic:** on each Compass API call, `record_compass_usage` checks if `last_reset_at` is more than 30 days ago — if so, it resets `tokens_used_this_month` to 0 and updates `last_reset_at`. The read path `get_compass_usage_state` applies the same rule so the UI stays consistent.

**Default limits:**

| Tier      | Monthly limit |
|-----------|---------------|
| Free      | 75,000        |
| Pro       | 1,500,000     |
| Workforce | 3,000,000     |

---

## Teams RLS (Workforce) — fix “infinite recursion”

If the app logs **`infinite recursion detected in policy for relation "teams"`** when loading Team / `getTeamByOwner`, Postgres is cycling between `teams` and `team_members` policies.

Run once in the **Supabase SQL Editor**:

[`supabase/migrations/20260329140000_teams_rls_fix_recursion.sql`](../supabase/migrations/20260329140000_teams_rls_fix_recursion.sql)

It replaces the cross-table subqueries with `SECURITY DEFINER` helpers so team rows resolve without RLS recursion.
