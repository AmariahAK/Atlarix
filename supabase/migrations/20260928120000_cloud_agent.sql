-- ---------------------------------------------------------------------------
-- The cloud agent: jobs, the Slack link, a second GitHub App, and 'cloud' spend.
-- ---------------------------------------------------------------------------
--
-- A user asks for work (Slack DM or atlarix.dev/cloud); the server dispatches a
-- workflow in THEIR repository; the Atlarix CLI runs in THEIR GitHub Actions
-- runner and opens a PR; Approve merges it. Compute is the user's Actions
-- minutes. What we hold is the job row, and what we bill is Core tokens.
--
-- WHO PAYS: the job's owner, through `debit_wallet_cloud`, which the proxy calls
-- for a request authenticated by a job-scoped run token (iss `atlarix-cloud`).
-- Wallet balance only — free Atlarix Auto never serves a cloud run (decided
-- 2026-09-28: long unattended runs are exactly what free tokens get farmed for).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. github_installs learns which App it belongs to.
-- ---------------------------------------------------------------------------
-- The cloud agent is a SEPARATE GitHub App ("Atlarix Agent", with write access)
-- so the Reviewer stays read-only. Installation ids are unique across Apps, so
-- one table still works — but anything that asks "does this user have AN
-- install?" must now say which App. The proxy's reviewer service path is the
-- one caller that did (`accountHasInstallation`); it filters on 'reviewer'.
ALTER TABLE public.github_installs
  ADD COLUMN IF NOT EXISTS app text NOT NULL DEFAULT 'reviewer'
  CHECK (app IN ('reviewer', 'agent'));

COMMENT ON COLUMN public.github_installs.app IS
  'Which GitHub App this installation is of: reviewer (read-only PR reviews) or agent (cloud agent, writes).';

-- The bind takes the App now. New signature, so DROP + CREATE (a REPLACE would
-- add an overload and make the four-argument call ambiguous).
DROP FUNCTION IF EXISTS public.bind_github_install_service(uuid, bigint, text, text);

CREATE FUNCTION public.bind_github_install_service(
  p_user_id uuid,
  p_installation_id bigint,
  p_account_login text DEFAULT NULL,
  p_repository_selection text DEFAULT NULL,
  p_app text DEFAULT 'reviewer'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  existing_owner uuid;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_user');
  END IF;
  IF p_installation_id IS NULL OR p_installation_id <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_installation');
  END IF;
  IF p_app IS NULL OR p_app NOT IN ('reviewer', 'agent') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_app');
  END IF;

  SELECT user_id INTO existing_owner
  FROM github_installs WHERE installation_id = p_installation_id FOR UPDATE;

  -- Unchanged from 20260826150000: a takeover is an explicit human act
  -- (uninstall and reinstall), never a side effect of visiting a URL.
  IF existing_owner IS NOT NULL AND existing_owner <> p_user_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'installation_already_bound');
  END IF;

  INSERT INTO github_installs (
    installation_id, user_id, account_login, repository_selection, removed_at, app
  )
  VALUES (
    p_installation_id, p_user_id, p_account_login, p_repository_selection, NULL, p_app
  )
  ON CONFLICT (installation_id) DO UPDATE
  SET user_id = EXCLUDED.user_id,
      account_login = COALESCE(EXCLUDED.account_login, github_installs.account_login),
      repository_selection =
        COALESCE(EXCLUDED.repository_selection, github_installs.repository_selection),
      removed_at = NULL,
      app = EXCLUDED.app,
      updated_at = now();

  RETURN jsonb_build_object(
    'ok', true, 'installation_id', p_installation_id, 'rebound', existing_owner IS NOT NULL
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.bind_github_install_service(uuid, bigint, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.bind_github_install_service(uuid, bigint, text, text, text)
  FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.bind_github_install_service(uuid, bigint, text, text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. cloud_jobs — one requested piece of work, from request to merge.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cloud_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  installation_id bigint NOT NULL,
  repo text NOT NULL,                          -- "owner/name"
  prompt text NOT NULL,
  -- What the run uses: paid Atlarix Auto (default), a paid Core tier, or the
  -- user's own key ('byok', free; such a run gets no Core token). Never free Auto.
  tier            text NOT NULL DEFAULT 'core-auto' CHECK (tier ~ '^(core-[a-z0-9-]+|byok)$'),
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'running', 'pr_opened', 'no_changes', 'merged', 'closed', 'failed')),
  branch text,
  pr_number integer,
  pr_url text,
  summary text,
  error text,
  spent_cents bigint NOT NULL DEFAULT 0,
  origin text NOT NULL CHECK (origin IN ('slack', 'web')),
  slack_team_id text,
  slack_channel text,
  slack_thread_ts text,
  -- The Actions run that claimed it, for the "open the log" link.
  github_run_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cloud_jobs_user ON public.cloud_jobs (user_id, created_at DESC);
-- The stale sweep reads by state + age.
CREATE INDEX IF NOT EXISTS idx_cloud_jobs_state ON public.cloud_jobs (state, created_at);

COMMENT ON TABLE public.cloud_jobs IS
  'Cloud agent jobs. Written only by the atlarix-reviewer service (service role); owners read their own.';

ALTER TABLE public.cloud_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cloud_jobs_select_own" ON public.cloud_jobs
  FOR SELECT TO authenticated USING (user_id = auth.uid());
-- A policy only narrows rows a role may ALREADY read (see 20260826150000 §2).
GRANT SELECT ON public.cloud_jobs TO authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.cloud_jobs FROM authenticated;
REVOKE ALL ON public.cloud_jobs FROM anon;
REVOKE TRUNCATE, MAINTAIN ON public.cloud_jobs FROM service_role;

-- ---------------------------------------------------------------------------
-- 3. Slack: one row per workspace install, one per linked person.
-- ---------------------------------------------------------------------------
-- The bot token is encrypted by the service (AES-GCM, SLACK_TOKEN_KEY) before
-- it gets here, so a leak of this table alone posts nothing anywhere.
CREATE TABLE IF NOT EXISTS public.slack_installs (
  team_id text PRIMARY KEY,
  team_name text,
  bot_user_id text NOT NULL,
  bot_token_enc text NOT NULL,
  installed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.slack_installs ENABLE ROW LEVEL SECURITY;
-- No policy for authenticated: service role only.
REVOKE ALL ON public.slack_installs FROM authenticated, anon;
REVOKE TRUNCATE, MAINTAIN ON public.slack_installs FROM service_role;

-- A Slack person → an Atlarix account. The link is made on atlarix.dev by the
-- signed-in account holder, from a link the bot sent them; never from Slack alone,
-- because a Slack display name or email is not proof of owning an Atlarix account.
CREATE TABLE IF NOT EXISTS public.slack_links (
  team_id text NOT NULL,
  slack_user_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  default_repo text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, slack_user_id)
);
CREATE INDEX IF NOT EXISTS idx_slack_links_user ON public.slack_links (user_id);
ALTER TABLE public.slack_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY "slack_links_select_own" ON public.slack_links
  FOR SELECT TO authenticated USING (user_id = auth.uid());
-- Unlinking is the owner's own call, so DELETE is theirs too.
CREATE POLICY "slack_links_delete_own" ON public.slack_links
  FOR DELETE TO authenticated USING (user_id = auth.uid());
GRANT SELECT, DELETE ON public.slack_links TO authenticated;
REVOKE INSERT, UPDATE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.slack_links FROM authenticated;
REVOKE ALL ON public.slack_links FROM anon;
REVOKE TRUNCATE, MAINTAIN ON public.slack_links FROM service_role;

-- ---------------------------------------------------------------------------
-- 4. 'cloud' on the ledger.
-- ---------------------------------------------------------------------------
-- Same generated-name lookup as 20260913120000 §1.
DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT con.conname INTO constraint_name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
   WHERE nsp.nspname = 'public'
     AND rel.relname = 'credit_transactions'
     AND con.contype = 'c'
     AND pg_get_constraintdef(con.oid) ILIKE '%source%'
   LIMIT 1;
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.credit_transactions DROP CONSTRAINT %I', constraint_name);
  END IF;
END;
$$;

ALTER TABLE public.credit_transactions
  ADD CONSTRAINT credit_transactions_source_check
  CHECK (source IN ('app', 'reviewer', 'cli', 'extension', 'cloud'));

COMMENT ON COLUMN public.credit_transactions.source IS
  'Which Atlarix surface spent this: app (desktop), reviewer, cli, extension, cloud. '
  'Set server-side from a validated header or token — never from a client string.';

-- ---------------------------------------------------------------------------
-- 5. debit_wallet_cloud — the only way 'cloud' spend is written.
-- ---------------------------------------------------------------------------
-- Separate from debit_wallet_service on purpose: it also adds to the job's
-- running total IN THE SAME TRANSACTION, and it refuses a job that is not
-- running. A run token that outlives its job (the job was swept as failed, or
-- completed) must stop spending even before the token's own expiry.
CREATE FUNCTION public.debit_wallet_cloud(
  p_user_id uuid,
  p_job_id uuid,
  p_generation_id text,
  p_cents bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  bal bigint;
  job_repo text;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF p_cents IS NULL OR p_cents <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_amount');
  END IF;
  IF p_generation_id IS NULL OR length(trim(p_generation_id)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_generation_id');
  END IF;

  SELECT repo INTO job_repo
    FROM cloud_jobs
   WHERE id = p_job_id AND user_id = p_user_id AND state = 'running'
   FOR UPDATE;
  IF job_repo IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'job_not_running');
  END IF;

  INSERT INTO credit_wallet (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO credit_transactions (user_id, delta_cents, kind, ref, source, repo)
  VALUES (p_user_id, -p_cents, 'debit', p_generation_id, 'cloud', job_repo)
  ON CONFLICT (kind, ref) DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', true, 'balance_cents', wallet_spendable(p_user_id), 'duplicate', true
    );
  END IF;

  bal := spend_from_wallet(p_user_id, p_cents, 'pro');
  UPDATE cloud_jobs
     SET spent_cents = spent_cents + p_cents, updated_at = now()
   WHERE id = p_job_id;
  RETURN jsonb_build_object('ok', true, 'balance_cents', bal);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.debit_wallet_cloud(uuid, uuid, text, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.debit_wallet_cloud(uuid, uuid, text, bigint) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.debit_wallet_cloud(uuid, uuid, text, bigint) TO service_role;

-- VERIFY after applying (the CLI's "up to date" proves nothing about ACLs):
--   SELECT p.proname, p.proacl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.proname IN ('debit_wallet_cloud', 'bind_github_install_service');
--   -- neither may show `=X/` (PUBLIC)
--   SELECT grantee, privilege_type FROM information_schema.role_table_grants
--    WHERE table_name IN ('cloud_jobs', 'slack_installs', 'slack_links')
--      AND privilege_type IN ('TRUNCATE', 'MAINTAIN');
--   -- expect no rows

COMMIT;
