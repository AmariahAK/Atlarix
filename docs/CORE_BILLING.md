# Atlarix Core — billing and plans

How Atlarix charges for Core inference, and where each rule is enforced.

**Numbers are deliberately left out of this document.** The lineup, the Auto chain, the
caps, the markup and the allowance all change without a doc edit, so each rule below names the
file that holds its value. The one public figure is the Pro price, **$19/month**.

## The model today

- **The app is free.** Every feature is on every plan; nothing is gated on paying. The only
  paid thing is Core inference.
- **BYOK and local models are free** on every plan and never touch the wallet.
- **Pro ($19/month)** carries a monthly **Core allowance**, spent across the desktop app, the
  Chrome extension and Atlarix Reviewer from one balance. There is no separate
  Reviewer subscription (folded into Pro on 2026-09-08).
- **Pay-as-you-go credit** tops up the same balance, with or without Pro.
- **Atlarix Auto** is one Core option for everyone and the default for new installs
  (`DEFAULT_NEW_USER_CORE_TIER = CORE_TIER_AUTO`, `src/ipc/shared/compass_constants.ts`). The
  **proxy decides who pays, from the account, never from the client**
  (`routeAuto`, `atlarix-proxy/src/server.ts`):
  - **With a Pro allowance or credit**, Auto is PAID. It is routed per request from the
    client's hints (work mode, purpose, deep thinking) and billed for the model that actually
    answered (`atlarix-proxy/src/paid-auto.ts`). A paying caller never falls into the free pool.
  - **With nothing to pay with**, Auto is FREE. It is served from OpenAI's complimentary
    shared-data tokens with a $0 floor model behind them, and requires a one-time consent in
    the desktop app (`X-Atlarix-Free-Consent: 1`; `src/components/AtlarixAutoConsentDialog.tsx`).
    **The Chrome extension is paid-only** (owner decision 2026-09-23): the proxy never serves the
    `extension` surface from the free pool, so a no-credit extension user gets the 402 and the
    upgrade line.
    Each user gets a fair daily share of what is left in the pools
    (`atlarix-proxy/src/free-auto.ts`). It never touches the wallet.
  - **Reviewer** gets free Auto only for **public** repositories: the installer of a private
    repo cannot consent for whoever owns that code.
  - Otherwise the proxy returns a 402 that says whether free Auto was on offer, so the client
    can show the consent notice rather than a bare "add credit".
- **Pinned Core models** (any tier other than Auto) always need a Pro allowance or credit.
- **There is no signup trial.** The $1 grant and `claim_signup_credit` were removed on
  2026-09-08 (`20260908140000_remove_signup_trial_credit.sql`). Free Auto is the free entry
  point; a top-up is the paid one.

**Customer copy never states the allowance in dollars.** See the rule at the top of
[`src/shared/billing_copy.ts`](../src/shared/billing_copy.ts), which holds every sentence the
app says about money and must stay in sync with `atlarix-launchpad/src/data/products.ts`.

## Where the pieces live

| What                           | Source of truth                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Core lineup, routing, Auto chain and paid lanes | `core-models.json` in `atlarix-releases` (changes without an app release), parsed by `atlarix-proxy/src/model-config.ts` |
| Prices                         | the **models.dev** catalog, the same one the desktop client caches                                                        |
| Markup, reserve and settle     | `MARKUP` in `atlarix-proxy/src/server.ts`; `reserveCentsForCall` and the settle math in `atlarix-proxy/src/cost.ts`       |
| Free Auto pools and fair share | `atlarix-proxy/src/free-auto.ts`; counters in `free_usage_daily` (`20260923120000_atlarix_auto_free_usage.sql`)           |
| Pro allowance                  | `MONTHLY_GRANT_CENTS` in `supabase/functions/handle-lemon-webhook/index.ts`, written to `credit_grants`                   |
| Top-up minimum and presets     | `MIN_TOPUP_CENTS` / `PRESET_TOPUPS_CENTS` in `src/components/settings/AtlarixCoreUsageCard.tsx`                          |
| Checkout                       | `supabase/functions/create-checkout` (per-checkout `custom_price`)                                                        |
| Workspace caps                 | `src/lib/workspace-caps.ts`                                                                                               |

## How a Core call is billed

- **Wallet and ledger.** Each user has a prepaid balance in `credit_wallet` (integer cents)
  and an append-only `credit_transactions` ledger
  (`supabase/migrations/20260714120000_credit_wallet.sql`). Every change goes through
  idempotent `SECURITY DEFINER` RPCs; direct writes are revoked from `anon` and
  `authenticated`, and RLS limits `SELECT` to the owner.
- **Allowance first.** `spend_from_wallet` spends the Pro allowance in `credit_grants` first
  and purchased credit after. Spend is attributed per surface through the ledger's `source`
  column (`app`, `extension`, `reviewer`, and `cli` reserved for the CLI;
  `20260913120000_ledger_surface_attribution.sql`), so there is one balance but per-surface
  spend. Never sum `delta_cents` to get a balance.
- **Computed cost, marked up.** The proxy prices each call from models.dev and debits
  computed cost times `MARKUP`. `cost.ts` is deliberately pure (no fetch, env or clock) so
  the money math is provable in unit tests. Cost is computed from token counts and catalog
  prices, not passed through from a provider, so a wrong price row is a silent mischarge.
  Where a value is unknowable the code over-charges on purpose: an under-charge is invisible
  forever, an over-charge shows up in the wallet and gets reported.
- **Reserve before forwarding.** The proxy reserves the worst-case cost of a call before
  forwarding it. If the balance cannot cover it, the call is refused up front with
  **402 `insufficient_credit`**, so a call that starts always finishes. A managed-key failure
  returns **503 `core_unavailable`**. A banned account gets **403 `account_banned`** on every
  path, free Auto included (see [`BAN_RUNBOOK.md`](./BAN_RUNBOOK.md)).
- **Top-ups** go through one LemonSqueezy "Atlarix Core Credit" product with a per-checkout
  `custom_price`. The `order_created` / `order_refunded` webhook credits or claws back the
  wallet; the `subscription_*` events manage Pro and its grant.

`atlarix-proxy/src/pricing.ts` (the old OpenRouter catalog fetch) is orphaned. Do not read it
as live behaviour.

## Workspace caps — the same on every plan

The app has no feature limits by plan. What remains are resource caps, which exist because a
workspace with dozens of MCP servers is one nobody can reason about, not because someone has
not paid.

**Two things are capped, and `WorkspaceCapKind` in `src/lib/workspace-caps.ts` is the whole
list** (MCP servers and automations per workspace, with their values beside it). If a
capability is not in that union it has no cap. Workspaces are unlimited.

**Skills are uncapped by nature.** They are markdown files in the user's repo under
`.atlarix/skills/`, and you cannot refuse a file the user already committed.
`SKILLS_WORKSPACE_MAX` was retired in v14.45 with the skills marketplace; what bounds their cost
is the skill index (one line each, read in full only when relevant), not a count.

## Schema

Migrations under `supabase/migrations/` are the source of truth and are applied with the
Supabase CLI. The billing ones worth knowing:

- `20260714120000_credit_wallet.sql`: wallet, ledger and RPCs.
- `20260714130000_pricing_reframe_teardown.sql`: dropped teams and the old `compass_tokens`
  allowance pool, and collapsed tiers to `free | pro`.
- `20260826130000_subscription_credit_grants.sql`: the per-subscription allowance.
- `20260908140000_remove_signup_trial_credit.sql`: removed the $1 trial.
- `20260913120000_ledger_surface_attribution.sql`: per-surface `source` on the ledger.
- `20260923120000_atlarix_auto_free_usage.sql`: free Auto counters and their ban check.

## History

- **v14.11.0**: Core became pay-as-you-go from a prepaid wallet. The monthly `compass_tokens`
  pool and the Team tier were removed; tiers became Free and Pro.
- **v14.38.0**: subscriptions started carrying a monthly Core allowance.
- **2026-09-08**: the $1 signup trial was removed, and the Reviewer subscription was folded
  into Pro.
- **v14.45.0**: the app became free with no feature gating. The skills marketplace went, and
  billing moved from OpenRouter's catalog to models.dev.
- **2026-09-23**: Atlarix Auto, one option for everyone, free or paid as decided by the proxy,
  and the default for new installs.

The product was once called "Compass". Internal identifiers such as `compass_constants.ts`
and the `"compass"` provider id keep the old name; user-facing copy says Atlarix Core.
