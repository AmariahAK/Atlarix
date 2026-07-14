-- Fix: the credit RPCs (credit_wallet_service / debit_wallet / claim_signup_credit)
-- use `INSERT ... ON CONFLICT (kind, ref) DO NOTHING`, but the idempotency index
-- was PARTIAL (`WHERE ref IS NOT NULL`). Postgres won't infer a partial index for
-- ON CONFLICT unless the same predicate is given, so every write raised
-- `42P10: no unique or exclusion constraint matching the ON CONFLICT specification`
-- — silently breaking top-up crediting, inference debiting, and the trial credit.
--
-- Replace it with a plain unique index on (kind, ref) so ON CONFLICT (kind, ref)
-- matches. ref is always set for topup/debit/trial; NULL refs stay distinct (fine
-- for un-keyed 'adjustment' rows). The table is append-only and currently tiny, so
-- no existing rows conflict.
DROP INDEX IF EXISTS public.credit_transactions_kind_ref_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS credit_transactions_kind_ref_uniq
  ON public.credit_transactions (kind, ref);
