-- Tear down Atlarix Reviewer's separate subscription. Entitlement is now the wallet.
--
-- APPLY THIS ONLY AFTER THE REVIEWER IS DEPLOYED WITHOUT ITS ENTITLEMENT GATE.
-- `atlarix-reviewer/src/jobs/queue.ts` calls `reviewer_entitlement_service` on every job.
-- Dropping the function under a running worker makes that call error, and the worker
-- deliberately THROWS on an entitlement error rather than refusing a paying customer —
-- so every job re-queues forever, quietly. Code first, then this file.
--
-- WHAT REPLACES IT. `worker.ts` now runs the balance check as its only gate. That is a
-- deliberate reversal of the comment that used to sit above it — "a funded wallet is not
-- evidence of a Reviewer subscription" — because under one subscription it now is exactly
-- that. Reviewer and the Chrome extension are Core-only with no BYOK, so a funded wallet
-- is the natural gate: you cannot use them without paying for inference either way.
--
-- THE BAN GATE SURVIVES. It rode both reads, not just this one: `get_credit_balance_service`
-- carries the same `account_banned` check, and `worker.ts` returns silently on it. Verified
-- before writing this — deleting the entitlement call drops no ban coverage.
--
-- WHAT IS LOST, honestly: `not_subscribed` was the only path where Reviewer explained its
-- own silence on a pull request. The remaining explanation is the out-of-credit nudge,
-- which has been rewritten to cover "never funded a wallet" as well as "ran out", because
-- with the app free and the trial credit gone the former is now the ordinary first-run
-- state for a new user.

-- ---------------------------------------------------------------------------
-- 1. The entitlement gate.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.reviewer_entitlement_service(uuid);

-- ---------------------------------------------------------------------------
-- 2. The writer the LemonSqueezy webhook used to call.
-- ---------------------------------------------------------------------------
-- `handle-lemon-webhook` no longer classifies a payment by product: there is one
-- subscription, so `productOf` and every reviewer branch are gone with it.
DROP FUNCTION IF EXISTS public.upsert_reviewer_subscription_service(
  uuid, text, text, text, timestamptz
);

-- ---------------------------------------------------------------------------
-- 3. The table.
-- ---------------------------------------------------------------------------
-- Production held exactly one row at the time of writing (the owner's `comp:owner`
-- entitlement, verified 2026-09-08). Dropping it removes that comp — which is fine and
-- was checked: the owner's wallet carries a large comped balance, so the bot stays
-- entitled under the balance gate that replaces this table.
--
-- No archive table. The row was an entitlement flag, not a record of money moving; every
-- payment it ever represented is already in `credit_transactions`, which is untouched.
DROP TABLE IF EXISTS public.reviewer_subscriptions;
