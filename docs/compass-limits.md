# Atlarix Core billing & plan limits (pay-as-you-go credit wallet)

> **2026-09-23 — ATLARIX AUTO is one option for everyone, and the default for new installs.**
> The proxy decides who pays from the account: with a Pro allowance or credit, Auto is
> PAID, routed per step (mode / purpose / deep thinking / media) and never shared; with
> nothing to pay with, Auto is FREE on OpenAI's shared-data tokens after a one-time OK,
> with a fair daily share. Pinned Core models always need Pro or credit.

> **v14.45.0 (2026-09-10) — the app is FREE, and the price catalog is models.dev.**
> Every feature is on every plan; the only paid thing is Core inference. The skills
> marketplace and its `SKILLS_WORKSPACE_MAX` cap are gone — repo skills under
> `.atlarix/skills/` were never capped and cannot be (you cannot refuse a file the user
> already committed). **Billing no longer reads OpenRouter's catalog** — see
> "How Core billing works" below.
>
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
- **Metering + markup.** The proxy (`atlarix-proxy`) prices each Core call from the
  **models.dev** catalog and debits **computed cost + 80% mark-up** (`MARKUP = 1.8`,
  `src/server.ts`). `cost.ts` is the billing authority and is deliberately PURE — no
  fetch, no env, no clock — so the money math is provable in unit tests.
  - **It is no longer "real cost".** Going direct to provider APIs lost OpenRouter's
    `usage.cost`, which was an actual dollar figure. Cost is now *computed* from token
    counts × catalog prices, so a wrong price row is a silent mischarge rather than a
    passthrough. Where a value is unknowable the code over-charges on purpose: an
    under-charge is invisible and absorbed forever, an over-charge shows up in the
    wallet and gets reported.
  - **`src/pricing.ts` (the OpenRouter catalog fetch) is ORPHANED** — nothing imports it.
    It is what this doc used to describe. `reserveCentsForCall` lives in `cost.ts`, so
    both the reserve and the settle price from models.dev. Do not read `pricing.ts` as
    live behaviour. (`openrouter.ts` is different and IS live — OpenRouter remains a
    routing option, just not a price source.)
- **Per-call reserve gate.** Before forwarding a Core call the proxy reserves the worst-case cost
  (`est input × prompt price + max output × completion price`, × markup). If the wallet can't cover
  it, the call is rejected up front with **HTTP 402 `insufficient_credit`** — a call that starts
  always finishes, it never aborts mid-stream. If a managed key fails, the proxy returns **503
  `core_unavailable`** with a neutral "overloaded" message.
- **Top-ups.** Minimum top-up **$10** (`MIN_TOPUP_CENTS = 1000`), presets **$10 / $20 / $50**, via a
  single LemonSqueezy "Atlarix Core Credit" product with a per-checkout `custom_price`. The
  `order_created` / `order_refunded` webhook credits / claws back the wallet.
- **No trial credit.** The one-time $1 signup grant was removed on 2026-09-08 along with
  `claim_signup_credit`. It was sized when a turn cost 2–29c; on the frontier tiers Core now
  maps (GPT 5.6 Terra, GPT 6 Astra) a turn runs an order of magnitude higher, so $1 bought one
  or two turns rather than a session. A $10 top-up is the entry point. The lineup is
  `core-models.json` and changes without a release — do not re-pin this note to today's models.
- **BYOK & local are free.** Bring-your-own-key providers and local Ollama / LM Studio never touch
  the wallet on any plan.

## Workspace limits — the same on every plan

**There are no plan limits on features as of 2026-09-08.** The app is free: unlimited
workspaces, the MCP marketplace, one-click connectors, automations and workspace snapshots
are available whether or not anyone has paid. What remains are resource caps, and they
exist because a workspace with fifty MCP servers is one nobody can reason about — not
because somebody has not paid.

**TWO things are capped, and `WorkspaceCapKind` is the whole list** (`"mcp" | "automations"`
in `src/lib/workspace-caps.ts`). If a capability is not in that union it has no cap, and a
row here claiming one is fiction.

| Capability              | Every plan           |
| ----------------------- | -------------------- |
| Atlarix Auto            | Free with no credit; paid with Pro or credit |
| Atlarix Core (pinned)   | Pro allowance or pay-as-you-go credit |
| Workspaces              | Unlimited            |
| MCP servers / workspace | 10                   |
| Automations / workspace | 10                   |
| Skills                  | **Uncapped**         |
| BYOK / local models     | Free                 |

**Skills are uncapped by nature, not by generosity.** They are markdown files in the
user's own repo under `.atlarix/skills/`, and you cannot refuse a file that already
exists. `SKILLS_WORKSPACE_MAX = 10` was retired in v14.45 because its only enforcement
site was `skills:install`, which the marketplace deletion removed; repo skills were never
capped at all. What bounds their cost is the skill INDEX — one line each, read wholesale
only when relevant — not a count.

This table previously carried an **"Agent Behaviors — 10 / workspace, marketplace
included"** row. There is no such cap and no such marketplace: the name appears nowhere in
the codebase except marketing copy in `src/pages/tools.tsx`, which still advertises "the
Agent Behaviors and MCP marketplaces" and is itself stale. That page's own comment records
this happening twice before ("Both were advertised here after they stopped existing").

What Pro buys is **Atlarix Reviewer plus a monthly Core allowance**, over one shared
balance — not a feature tier.

Limit constants live with their enforcement:
`MCP_WORKSPACE_MAX` / `AUTOMATIONS_WORKSPACE_MAX` (`src/lib/workspace-caps.ts`, re-exported
by `src/ipc/handlers/mcp_handlers.ts` and `src/lib/automations/service.ts`),
`MIN_TOPUP_CENTS` / `PRESET_TOPUPS_CENTS` (`src/components/settings/AtlarixCoreUsageCard.tsx`),
and the proxy's `MARKUP` (`atlarix-proxy/src/server.ts`) + the reserve/settle math
(`cost.ts`). `SKILLS_WORKSPACE_MAX` is deliberately absent — see above.
