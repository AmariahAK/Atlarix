-- =============================================================================
-- Atlarix Reviewer — installs, the durable job queue, history, and a service
-- debit path.
-- =============================================================================
-- The reviewer is a SECOND product spending from the SAME wallet as the desktop
-- app. Nothing here forks the money: `credit_wallet` and `credit_transactions`
-- stay exactly as they are, and the new RPCs are service-role siblings of the
-- existing ones rather than a parallel accounting system.
--
-- WHY SERVICE-ROLE SIBLINGS ARE NEEDED AT ALL. `debit_wallet` and
-- `get_credit_balance` derive the payer from `auth.uid()`. A pull-request
-- webhook fires when NOBODY IS SIGNED IN — the account exists and its wallet has
-- money, but there is no session, so `auth.uid()` is null and both reject. This
-- is the same shape `credit_wallet_service` already solves for the LemonSqueezy
-- webhook; these follow it.
--
-- ADDITIVE ONLY. No existing table, policy, function or grant is altered.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- github_installs — the bind. Its EXISTENCE is what "connected" means.
-- ---------------------------------------------------------------------------
-- Installing the GitHub App and having an Atlarix account are two separate
-- systems; this row is the only thing joining them. Written by the atlarix.dev
-- setup page after the person signs in, holding the `installation_id` GitHub
-- handed back on redirect.
CREATE TABLE IF NOT EXISTS public.github_installs (
  installation_id bigint PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  -- Whose account the App is installed on (a user or an org login).
  account_login text,
  -- GitHub's own words: 'all' or 'selected'.
  repository_selection text,
  -- Set when the App is uninstalled. Kept rather than deleted so review_history
  -- and the ledger still resolve after someone removes the App.
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_github_installs_user ON public.github_installs (user_id);

COMMENT ON TABLE public.github_installs IS
  'installation_id -> account. The existence of a row IS "connected".';

-- ---------------------------------------------------------------------------
-- review_jobs — the durable queue.
-- ---------------------------------------------------------------------------
-- A webhook must answer in seconds; a review takes minutes. So the endpoint
-- writes a row and returns 202, and a worker claims it. Postgres rather than an
-- in-process queue because a review COSTS MONEY: a Railway redeploy mid-review
-- would drop an in-memory job, and GitHub will not redeliver a webhook that was
-- already answered 202.
CREATE TABLE IF NOT EXISTS public.review_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id bigint NOT NULL,
  repo text NOT NULL,                 -- "owner/name"
  pr_number integer NOT NULL,
  head_sha text NOT NULL,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'running', 'done', 'failed', 'superseded')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  -- Set when a worker claims the row; lets a crashed worker's job be reclaimed.
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- IDEMPOTENCY. GitHub redelivers webhooks, and `pull_request.synchronize` fires
-- on every push. One row per (repo, pr, head_sha) means a redelivery cannot
-- enqueue the same review twice.
CREATE UNIQUE INDEX IF NOT EXISTS review_jobs_repo_pr_sha_uniq
  ON public.review_jobs (repo, pr_number, head_sha);

-- The worker's claim query: oldest queued first.
CREATE INDEX IF NOT EXISTS idx_review_jobs_claimable
  ON public.review_jobs (state, created_at) WHERE state = 'queued';

-- Finding the in-flight job for a PR, to supersede it when a new push arrives.
CREATE INDEX IF NOT EXISTS idx_review_jobs_open_pr
  ON public.review_jobs (repo, pr_number) WHERE state IN ('queued', 'running');

COMMENT ON TABLE public.review_jobs IS
  'Durable review queue. Unique on (repo, pr_number, head_sha) so a redelivered webhook cannot double-enqueue.';

-- ---------------------------------------------------------------------------
-- review_history — what was actually posted.
-- ---------------------------------------------------------------------------
-- Also the out-of-credits bookkeeping: the nudge is posted ONCE per pull
-- request, and this is what makes "have we already told them?" answerable.
CREATE TABLE IF NOT EXISTS public.review_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  installation_id bigint,
  repo text NOT NULL,
  pr_number integer NOT NULL,
  head_sha text,
  kind text NOT NULL DEFAULT 'review'
    CHECK (kind IN ('review', 'out_of_credits', 'failed')),
  findings_count integer NOT NULL DEFAULT 0,
  cents_spent bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_review_history_user ON public.review_history (user_id);
CREATE INDEX IF NOT EXISTS idx_review_history_pr ON public.review_history (repo, pr_number);

COMMENT ON TABLE public.review_history IS
  'One row per posted review or nudge. The out-of-credits nudge is once per PR; this is how that is enforced.';

-- ---------------------------------------------------------------------------
-- credit_transactions gains a source discriminator.
-- ---------------------------------------------------------------------------
-- One wallet, two products spending from it. Without this, reviewer spend is
-- indistinguishable from app spend on the account page — and §8's per-repo
-- consumption guardrail has nothing to group by.
--
-- DEFAULT 'app' so every existing row keeps its meaning and every existing
-- writer (which does not know about this column) keeps working unchanged.
ALTER TABLE public.credit_transactions
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'app'
    CHECK (source IN ('app', 'reviewer'));
ALTER TABLE public.credit_transactions
  ADD COLUMN IF NOT EXISTS repo text;

CREATE INDEX IF NOT EXISTS idx_credit_transactions_repo
  ON public.credit_transactions (user_id, repo) WHERE repo IS NOT NULL;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.github_installs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_history ENABLE ROW LEVEL SECURITY;

-- Owners may READ their own installs and history (the account page). Every
-- WRITE goes through the service role, mirroring credit_wallet.
-- DROP-then-CREATE because Postgres has no CREATE POLICY IF NOT EXISTS, and this
-- file should survive being re-run (house convention — see account_bans).
DROP POLICY IF EXISTS "github_installs_select_own" ON public.github_installs;
CREATE POLICY "github_installs_select_own" ON public.github_installs
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "review_history_select_own" ON public.review_history;
CREATE POLICY "review_history_select_own" ON public.review_history
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- review_jobs gets NO policy on purpose: RLS is enabled and nothing is granted,
-- so it is unreadable and unwritable by `authenticated` and `anon` entirely. It
-- is worker-internal state; a customer has review_history instead.

-- Defense in depth, mirroring credit_wallet: revoke direct DML so a future
-- permissive policy cannot silently re-open table writes.
REVOKE INSERT, UPDATE, DELETE ON public.github_installs FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.review_jobs FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.review_history FROM authenticated, anon;
REVOKE SELECT ON public.review_jobs FROM authenticated, anon;

-- EXPLICIT GRANTS. Do not rely on whatever ALTER DEFAULT PRIVILEGES happens to
-- be configured — measured on a fresh instance, a newly created table lands with
-- `service_role=Dxtm` (TRUNCATE/REFERENCES/TRIGGER/MAINTAIN) and NO
-- SELECT/INSERT/UPDATE/DELETE for anyone.
--
-- Two things break silently without these:
--   * The worker cannot read or claim its own queue — it connects with the
--     service key and every `review_jobs` statement is permission-denied.
--   * The RLS SELECT policies above are UNREACHABLE. A policy filters rows a
--     role may already read; with no table-level SELECT there is nothing to
--     filter, so the account page could never load a customer's installs or
--     history however correct the policy is.
GRANT SELECT, INSERT, UPDATE ON public.review_jobs TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.github_installs TO service_role;
GRANT SELECT, INSERT ON public.review_history TO service_role;

-- Read-only for the owner; RLS narrows these to their own rows.
GRANT SELECT ON public.github_installs TO authenticated;
GRANT SELECT ON public.review_history TO authenticated;

-- No DELETE anywhere on purpose: jobs are marked `superseded` rather than
-- removed, and an uninstall sets `removed_at`, so history stays resolvable.

-- ---------------------------------------------------------------------------
-- get_credit_balance_service(user_id) — service-role only.
-- ---------------------------------------------------------------------------
-- The PRE-FLIGHT GATE, and the thing that actually stops runaway spend. Note
-- that `debit_wallet` below deliberately does not refuse an overdraft: a debit
-- that reconciles tokens already consumed must always land, or spend is lost
-- silently. Refusing to START is the control; refusing to RECORD is data loss.
CREATE OR REPLACE FUNCTION public.get_credit_balance_service(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  bal bigint;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_user');
  END IF;

  SELECT balance_cents INTO bal FROM credit_wallet WHERE user_id = p_user_id;
  RETURN jsonb_build_object('ok', true, 'balance_cents', COALESCE(bal, 0));
END;
$$;

-- ---------------------------------------------------------------------------
-- debit_wallet_service(user_id, generation_id, cents, source, repo)
-- ---------------------------------------------------------------------------
-- Service-role sibling of `debit_wallet`, for a webhook-driven review where
-- there is no session. Idempotent on (kind, ref) exactly as the owner-scoped
-- one is, so a retried settle cannot double-charge.
CREATE OR REPLACE FUNCTION public.debit_wallet_service(
  p_user_id uuid,
  p_generation_id text,
  p_cents bigint,
  p_source text DEFAULT 'reviewer',
  p_repo text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  bal bigint;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_user');
  END IF;
  IF p_cents IS NULL OR p_cents <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_amount');
  END IF;
  IF p_generation_id IS NULL OR length(trim(p_generation_id)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_generation_id');
  END IF;
  IF p_source NOT IN ('app', 'reviewer') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_source');
  END IF;

  INSERT INTO credit_wallet (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO credit_transactions (user_id, delta_cents, kind, ref, source, repo)
  VALUES (p_user_id, -p_cents, 'debit', p_generation_id, p_source, p_repo)
  ON CONFLICT (kind, ref) DO NOTHING;
  IF NOT FOUND THEN
    -- Already charged for this generation — no-op, same as debit_wallet.
    SELECT balance_cents INTO bal FROM credit_wallet WHERE user_id = p_user_id;
    RETURN jsonb_build_object('ok', true, 'balance_cents', bal, 'duplicate', true);
  END IF;

  UPDATE credit_wallet
  SET balance_cents = balance_cents - p_cents, updated_at = now()
  WHERE user_id = p_user_id
  RETURNING balance_cents INTO bal;

  RETURN jsonb_build_object('ok', true, 'balance_cents', bal);
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants — LAST, and after the final CREATE OR REPLACE.
-- ---------------------------------------------------------------------------
-- THE TRAP THIS SECTION EXISTS FOR: `CREATE FUNCTION` grants EXECUTE to PUBLIC
-- by default, and `CREATE OR REPLACE` RE-ADDS that grant every time it runs.
-- Migration 20260714150000 exists only because its predecessor revoked from
-- `authenticated, anon` but not from `PUBLIC`, leaving a service-only function
-- callable by anyone. Revoking from PUBLIC is the one that matters; the
-- in-function `auth.role()` guards above are the second line, not the first.
REVOKE EXECUTE ON FUNCTION public.get_credit_balance_service(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_credit_balance_service(uuid) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.get_credit_balance_service(uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.debit_wallet_service(uuid, text, bigint, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.debit_wallet_service(uuid, text, bigint, text, text) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.debit_wallet_service(uuid, text, bigint, text, text) TO service_role;

COMMENT ON FUNCTION public.get_credit_balance_service(uuid) IS
  'Service-role pre-flight balance read for the reviewer (no session exists at webhook time).';
COMMENT ON FUNCTION public.debit_wallet_service(uuid, text, bigint, text, text) IS
  'Service-role debit for the reviewer. Idempotent on (kind, ref). Does not refuse an overdraft by design — the pre-flight balance check is the gate.';
