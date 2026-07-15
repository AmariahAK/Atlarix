# Atlarix Core billing & plan limits (pay-as-you-go credit wallet)

> **v14.11.0 — pricing reframe.** No plan bundles AI. **Atlarix Core is pay-as-you-go on
> every tier**, billed from a prepaid **credit wallet** (a dollar balance in cents), not a
> monthly token allowance. The earlier `compass_tokens` monthly-allowance pool and the
> **Team / Workforce** tier were removed. Tiers are now **Free** and **Pro** only.
>
> The teardown + wallet migrations are
> [`supabase/migrations/20260714120000_credit_wallet.sql`](../supabase/migrations/20260714120000_credit_wallet.sql)
> (wallet + RPCs) and
> [`supabase/migrations/20260714130000_pricing_reframe_teardown.sql`](../supabase/migrations/20260714130000_pricing_reframe_teardown.sql)
> (drop teams + `compass_tokens`, collapse tiers to `free | pro`).

## Run in Supabase SQL Editor

To create the **`credit_wallet`** table, the append-only **`credit_transactions`** ledger, RLS,
and the RPCs (`get_credit_balance`, `debit_wallet`, `claim_signup_credit`):

1. Open your Supabase project → **SQL Editor** → New query.
2. Paste the **entire** contents of [`supabase/migrations/20260714120000_credit_wallet.sql`](../supabase/migrations/20260714120000_credit_wallet.sql) and run it once.
3. Then run [`supabase/migrations/20260714130000_pricing_reframe_teardown.sql`](../supabase/migrations/20260714130000_pricing_reframe_teardown.sql) to drop the retired teams + `compass_tokens` objects and collapse tiers to `free | pro`.

The scripts are idempotent where possible (`CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`).
Direct `INSERT`/`UPDATE`/`DELETE` on `credit_wallet` is revoked from `authenticated`/`anon` — only the
`SECURITY DEFINER` RPCs may change the balance (RLS limits `SELECT` to the owning user).

## How Core billing works

- **Credit wallet.** Each user has a prepaid balance in `credit_wallet` (integer cents) with an
  append-only `credit_transactions` ledger. All changes go through idempotent `SECURITY DEFINER`
  RPCs — direct writes are revoked.
- **Metering + markup.** The proxy (`atlarix-proxy`) prices each Core call from OpenRouter's live
  model catalog and debits the **real cost + 40% markup** (`MARKUP = 1.4`).
- **Per-call reserve gate.** Before forwarding a Core call the proxy reserves the worst-case cost
  (`est input × prompt price + max output × completion price`, × markup). If the wallet can't cover
  it, the call is rejected up front with **HTTP 402 `insufficient_credit`** — a call that starts
  always finishes, it never aborts mid-stream. If a managed key fails, the proxy returns **503
  `core_unavailable`** with a neutral "overloaded" message.
- **Top-ups.** Minimum top-up **$10** (`MIN_TOPUP_CENTS = 1000`), presets **$10 / $20 / $50**, via a
  single LemonSqueezy "Atlarix Core Credit" product with a per-checkout `custom_price`. The
  `order_created` / `order_refunded` webhook credits / claws back the wallet.
- **Trial credit.** Each new account gets a one-time **$1** signup credit (`claim_signup_credit`,
  granted on first sign-in, idempotent per user).
- **BYOK & local are free.** Bring-your-own-key providers and local Ollama / LM Studio never touch
  the wallet on any plan.

## Plan limits (Free vs Pro)

| Capability                  | Free                  | Pro ($19/mo)          |
|-----------------------------|-----------------------|-----------------------|
| Atlarix Core (all 4 models) | Pay-as-you-go credits | Pay-as-you-go credits |
| Workspaces                  | 1                     | Unlimited             |
| MCP servers / workspace     | 1 (manual config)     | 10 + marketplace      |
| Automations / workspace     | 2                     | 10                    |
| Agent Behaviors             | `.atlarix/skills/`    | + marketplace         |
| BYOK / local models         | Free                  | Free                  |

Limit constants live with their enforcement:
`MCP_FREE_TIER_LIMIT` / `MCP_WORKSPACE_MAX` (`src/ipc/handlers/mcp_handlers.ts`),
`AUTOMATIONS_FREE_MAX` / `AUTOMATIONS_WORKSPACE_MAX` (`src/ipc/handlers/automation_handlers.ts`),
`MIN_TOPUP_CENTS` / `PRESET_TOPUPS_CENTS` (`src/components/settings/AtlarixCoreUsageCard.tsx`),
and the proxy's `MARKUP` + reserve gate (`atlarix-proxy/src/server.ts`, `pricing.ts`).
