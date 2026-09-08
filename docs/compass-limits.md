# Atlarix Core billing & plan limits (pay-as-you-go credit wallet)

> **v14.38.0 — SUPERSEDES the note below on one point.** A subscription now carries a
> monthly **Atlarix Core allowance**, so "no plan bundles AI" is no longer true. Both
> **Pro** and **Atlarix Reviewer** grant one — `MONTHLY_GRANT_CENTS` in
> [`supabase/functions/handle-lemon-webhook/index.ts`](../supabase/functions/handle-lemon-webhook/index.ts)
> — written to `credit_grants`, **one row per `(user, product)`**, by
> [`20260826130000_subscription_credit_grants.sql`](../supabase/migrations/20260826130000_subscription_credit_grants.sql).
> `spend_from_wallet` spends the allowance FIRST and the purchased wallet after, and it
> deliberately lets one product's allowance pay for the other — so there is no per-product
> balance, only per-product **spend**, recorded via the ledger's `source` column.
> The wallet, the ledger and the RPC surface below are otherwise unchanged.
>
> **NEVER PUBLISH THE ALLOWANCE IN DOLLARS** in customer-facing copy — see the rule at the
> top of [`src/shared/billing_copy.ts`](../src/shared/billing_copy.ts). Percentages only.
>
> **v14.11.0 — pricing reframe (HISTORICAL; the "no plan bundles AI" line is superseded
> above).** No plan bundles AI. **Atlarix Core is pay-as-you-go on
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
and the RPCs (`get_credit_balance`, `debit_wallet`):

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
- **No trial credit.** The one-time $1 signup grant was removed on 2026-09-08 along with
  `claim_signup_credit`. It was sized when a turn cost 2–29c; on the GPT 5.6 tiers a turn runs
  50–90c, so $1 bought one or two turns rather than a session. A $10 top-up is the entry point.
- **BYOK & local are free.** Bring-your-own-key providers and local Ollama / LM Studio never touch
  the wallet on any plan.

## Workspace limits — the same on every plan

**There are no plan limits on features as of 2026-09-08.** The app is free: unlimited
workspaces, both marketplaces, one-click connectors, automations and workspace snapshots
are available whether or not anyone has paid. What remains are resource caps, and they
exist because a workspace with fifty MCP servers is one nobody can reason about.

| Capability              | Every plan         |
|-------------------------|--------------------|
| Atlarix Core            | Pay-as-you-go credit |
| Workspaces              | Unlimited          |
| MCP servers / workspace | 10                 |
| Automations / workspace | 10                 |
| Agent Behaviors         | 10 / workspace, marketplace included |
| BYOK / local models     | Free               |

What Pro buys is **Atlarix Reviewer plus a monthly Core allowance**, over one shared
balance — not a feature tier.

Limit constants live with their enforcement:
`MCP_WORKSPACE_MAX` / `AUTOMATIONS_WORKSPACE_MAX` (`src/lib/workspace-caps.ts`, re-exported
by `src/ipc/handlers/mcp_handlers.ts` and `src/lib/automations/service.ts`),
`SKILLS_WORKSPACE_MAX` (`src/ipc/handlers/skills_handlers.ts`),
`MIN_TOPUP_CENTS` / `PRESET_TOPUPS_CENTS` (`src/components/settings/AtlarixCoreUsageCard.tsx`),
and the proxy's `MARKUP` + reserve gate (`atlarix-proxy/src/server.ts`, `cost.ts`).
