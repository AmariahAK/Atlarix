-- ---------------------------------------------------------------------------
-- Usage per user, per day, per surface: the record analytics cannot be.
-- ---------------------------------------------------------------------------
--
-- PostHog only sees people who opted in, and editors never asked: about a dozen
-- people in a month, with ACP editors and the VS Code panel all counted as
-- 'cli'. The proxy serves every Core and Auto request whatever the user chose,
-- so it writes what a request IS (which surface and editor, how it was paid for,
-- how big it was), never what it said.
--
-- WRITTEN IN BATCHES. The proxy totals requests in memory and sends one
-- `record_usage_batch` call a minute (and on SIGTERM), the way FreeUsageCache
-- does for the free counters. No client sends anything new.
--
-- REPORTING ONLY. Nothing reads this to decide what a user may do: the free
-- limit stays on free_usage_user_daily, money stays on the ledger. That is also
-- why the ledger's source allowlist is NOT widened here: an ACP or VS Code turn
-- is charged as 'cli' exactly as before, and the debit functions are untouched.
--
-- `editor` is '' rather than NULL so it can sit in the primary key.

BEGIN;

CREATE TABLE IF NOT EXISTS public.usage_daily (
  user_id    uuid   NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  day        date   NOT NULL,
  surface    text   NOT NULL
    CHECK (surface IN ('app', 'cli', 'acp', 'vscode', 'extension', 'reviewer', 'cloud', 'slack')),
  editor     text   NOT NULL DEFAULT '' CHECK (length(editor) <= 40),
  billing    text   NOT NULL
    CHECK (billing IN ('auto_free', 'auto_paid', 'core', 'reviewer', 'cloud')),
  requests   bigint NOT NULL DEFAULT 0 CHECK (requests >= 0),
  tokens_in  bigint NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
  tokens_out bigint NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
  cost_cents bigint NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  errors     bigint NOT NULL DEFAULT 0 CHECK (errors >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day, surface, editor, billing)
);

CREATE INDEX IF NOT EXISTS usage_daily_day_idx ON public.usage_daily (day);

COMMENT ON TABLE public.usage_daily IS
  'Core and Auto requests per user, UTC day, surface, editor and billing. Written by the proxy in batches; reporting only.';

ALTER TABLE public.usage_daily ENABLE ROW LEVEL SECURITY;
-- No policies: no client role reads or writes it. The service role bypasses RLS.
REVOKE ALL ON public.usage_daily FROM PUBLIC, anon, authenticated;

-- Where and when each person was first and last seen, kept on the user row so
-- "which surface do people start on" is one read.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS first_surface text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_surface text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS first_seen_at timestamptz;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

-- ---------------------------------------------------------------------------
-- record_usage_batch: one call per flush.
-- ---------------------------------------------------------------------------
-- p_rows: [{user_id, day, surface, editor, billing, requests, tokens_in,
--           tokens_out, cost_cents, errors, at}], where `at` is the last request
-- the row counts. A row that fails its CHECK is skipped and reported, never
-- allowed to sink the rest of the batch.
CREATE OR REPLACE FUNCTION public.record_usage_batch(p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r jsonb;
  written integer := 0;
  skipped integer := 0;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_arguments');
  END IF;

  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    BEGIN
      INSERT INTO usage_daily AS u
        (user_id, day, surface, editor, billing, requests, tokens_in, tokens_out, cost_cents, errors)
      VALUES (
        (r->>'user_id')::uuid,
        (r->>'day')::date,
        r->>'surface',
        COALESCE(r->>'editor', ''),
        r->>'billing',
        COALESCE((r->>'requests')::bigint, 0),
        COALESCE((r->>'tokens_in')::bigint, 0),
        COALESCE((r->>'tokens_out')::bigint, 0),
        COALESCE((r->>'cost_cents')::bigint, 0),
        COALESCE((r->>'errors')::bigint, 0)
      )
      ON CONFLICT (user_id, day, surface, editor, billing) DO UPDATE SET
        requests   = u.requests   + EXCLUDED.requests,
        tokens_in  = u.tokens_in  + EXCLUDED.tokens_in,
        tokens_out = u.tokens_out + EXCLUDED.tokens_out,
        cost_cents = u.cost_cents + EXCLUDED.cost_cents,
        errors     = u.errors     + EXCLUDED.errors,
        updated_at = now();

      UPDATE users SET
        first_surface = COALESCE(first_surface, r->>'surface'),
        first_seen_at = COALESCE(first_seen_at, COALESCE((r->>'at')::timestamptz, now())),
        last_surface  = CASE
          WHEN last_seen_at IS NULL OR COALESCE((r->>'at')::timestamptz, now()) >= last_seen_at
            THEN r->>'surface' ELSE last_surface END,
        last_seen_at  = GREATEST(COALESCE(last_seen_at, '-infinity'), COALESCE((r->>'at')::timestamptz, now()))
      WHERE id = (r->>'user_id')::uuid;

      written := written + 1;
    EXCEPTION WHEN check_violation OR invalid_text_representation OR foreign_key_violation
                   OR not_null_violation OR datetime_field_overflow OR invalid_datetime_format THEN
      skipped := skipped + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'written', written, 'skipped', skipped);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_usage_batch(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_usage_batch(jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_usage_batch(jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- Views for the questions asked most. Internal accounts are left out.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_active_by_surface
WITH (security_invoker = true) AS
SELECT d.day,
       d.surface,
       count(DISTINCT d.user_id) AS people,
       sum(d.requests)           AS requests
  FROM usage_daily d
  JOIN auth.users au ON au.id = d.user_id
 WHERE au.email NOT IN ('amariah.abish@gmail.com', 'amani.kamau06@gmail.com',
                        'agent@atlarix.dev', 'mojo.alexander3@gmail.com', 'amariah@atlarix.dev')
 GROUP BY d.day, d.surface;

COMMENT ON VIEW public.v_active_by_surface IS
  'People and requests per UTC day per surface, internal accounts excluded. Service role only.';

CREATE OR REPLACE VIEW public.v_activation
WITH (security_invoker = true) AS
WITH per_user AS (
  SELECT d.user_id,
         min(d.day)              AS first_day,
         count(DISTINCT d.day)   AS active_days
    FROM usage_daily d
   GROUP BY d.user_id
)
SELECT au.id                               AS user_id,
       au.created_at::date                 AS signed_up,
       u.first_surface,
       p.first_day                         AS first_request_day,
       COALESCE(p.active_days, 0)          AS active_days,
       COALESCE(p.active_days, 0) >= 2     AS came_back
  FROM auth.users au
  LEFT JOIN users u    ON u.id = au.id
  LEFT JOIN per_user p ON p.user_id = au.id
 WHERE au.email NOT IN ('amariah.abish@gmail.com', 'amani.kamau06@gmail.com',
                        'agent@atlarix.dev', 'mojo.alexander3@gmail.com', 'amariah@atlarix.dev');

COMMENT ON VIEW public.v_activation IS
  'Per account: signed up, first surface, first request, active days. Internal accounts excluded. Service role only.';

REVOKE ALL ON public.v_active_by_surface FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.v_activation FROM PUBLIC, anon, authenticated;

COMMIT;
