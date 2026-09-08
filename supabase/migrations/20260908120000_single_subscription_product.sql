-- One subscription, one allowance. Atlarix Pro now entitles the account to the desktop
-- app, Atlarix Reviewer and (later) the Chrome extension, and grants a SINGLE monthly
-- Core allowance covering all of them.
--
-- WHY. Two $19/mo subscriptions each carrying their own $10 allowance asked a customer
-- who had already paid $19 to pay $19 again, and nobody sells software that way — a
-- shared pool across surfaces is what every comparable product does. The wallet was
-- already built to spill allowance across products (see 20260826130000), so this is a
-- packaging change, not a re-architecture: what changes is that only ONE product ever
-- grants.
--
-- ORDERING — THIS IS THE OPPOSITE OF THE AUGUST MIGRATIONS, AND GETTING IT BACKWARDS
-- TAKES THE BOT DOWN. In August the code called a NEW function, so the SQL had to land
-- first. This is a TEARDOWN: the SQL removes something the running code still calls, so
-- the CODE must deploy first and the SQL second. Applying 20260908130000 before the
-- reviewer deploy leaves `reviewerEntitlement()` throwing, and the worker re-queues every
-- job forever rather than failing visibly.
--
-- This migration is the safe half — it only narrows a CHECK and merges rows. The drops
-- live in 20260908130000 so they can be applied separately, after the deploy.

-- ---------------------------------------------------------------------------
-- 1. Fold any reviewer allowance into the pro row.
-- ---------------------------------------------------------------------------
-- Verified 2026-09-08 against production: there are ZERO rows with product='reviewer',
-- so this is expected to be a no-op. It is written anyway because a Reviewer renewal
-- landing between now and apply-time would otherwise violate the CHECK below, and
-- because deleting a row that represents credit somebody paid for is not something to
-- leave to chance.
--
-- SUM rather than replace: the two allowances were separately funded, so the user's
-- spendable total must not shrink. `total_cents` follows the same rule — it is the
-- period's granted size, used for the breakdown display, not a second balance.
INSERT INTO public.credit_grants (user_id, product, cents, total_cents, ref, updated_at)
SELECT
  r.user_id,
  'pro',
  r.cents,
  r.total_cents,
  r.ref,
  now()
FROM public.credit_grants r
WHERE r.product = 'reviewer'
ON CONFLICT (user_id, product) DO UPDATE
SET
  cents = public.credit_grants.cents + EXCLUDED.cents,
  total_cents = public.credit_grants.total_cents + EXCLUDED.total_cents,
  updated_at = now();

DELETE FROM public.credit_grants WHERE product = 'reviewer';

-- ---------------------------------------------------------------------------
-- 2. Make a second grant product structurally impossible.
-- ---------------------------------------------------------------------------
-- Narrowing rather than leaving the old CHECK in place: with one subscription there is
-- exactly one granting product, and a constraint that still admits 'reviewer' invites a
-- future writer to reintroduce the split the whole change exists to remove.
--
-- The (user_id, product) primary key and the per-product row shape STAY. Adding the
-- Chrome extension later does not need a new grant product — it is covered by the same
-- Pro subscription — but if a genuinely separate allowance is ever wanted, widening this
-- CHECK is the one-line way back.
ALTER TABLE public.credit_grants DROP CONSTRAINT IF EXISTS credit_grants_product_check;
ALTER TABLE public.credit_grants
  ADD CONSTRAINT credit_grants_product_check CHECK (product IN ('pro'));

COMMENT ON TABLE public.credit_grants IS
  'Expiring subscription allowance, one row per user (product is always ''pro'' since the 2026-09-08 collapse to a single subscription). Spent BEFORE credit_wallet.balance_cents and RESET (not incremented) each period — unspent allowance is forfeited by design.';

-- ---------------------------------------------------------------------------
-- 3. `not_subscribed` is no longer a reachable review outcome.
-- ---------------------------------------------------------------------------
-- Reviewer now gates on WALLET BALANCE alone: any funded account may use it, whether the
-- funds came from the Pro allowance or a PAYG top-up. There is no subscription to lack,
-- so no review can end this way.
--
-- Historical rows are preserved deliberately — the constraint is re-added permitting the
-- value to exist in past data while nothing new can write it. A CHECK is only evaluated
-- on write, so an old `not_subscribed` row stays readable and the review history does not
-- develop a hole where a real outcome used to be.
ALTER TABLE public.review_history DROP CONSTRAINT IF EXISTS review_history_kind_check;
ALTER TABLE public.review_history
  ADD CONSTRAINT review_history_kind_check
  CHECK (kind IN ('review', 'out_of_credits', 'failed', 'not_subscribed'))
  NOT VALID;

COMMENT ON CONSTRAINT review_history_kind_check ON public.review_history IS
  'not_subscribed is retained for HISTORICAL rows only — the reviewer stopped writing it on 2026-09-08 when entitlement collapsed into the wallet gate. Do not treat its presence here as a live outcome.';
