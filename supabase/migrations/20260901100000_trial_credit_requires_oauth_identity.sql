-- The $1 trial credit was guarded per ACCOUNT, and accounts are free to create.
--
-- Found 2026-09-01, while explaining why an earlier answer of mine was wrong.
--
-- `claim_signup_credit()` is idempotent on `('trial', uid)`, which is correct as
-- far as it goes: nobody can claim twice. What it assumes is that an account is
-- a scarce thing. It is not.
--
-- Neither the desktop app nor the website has a single email-auth call site —
-- both use `signInWithOAuth` exclusively. That was the basis for believing there
-- was no exposure here, and it was the wrong thing to reason about. The Supabase
-- Auth REST API is public and the anon key ships inside the app binary and the
-- website bundle, so what OUR client calls does not bound what anyone else can
-- call. Probing the live project settled it:
--
--     curl -H "apikey: <anon>" https://<ref>.supabase.co/auth/v1/settings
--     → "email": true, "disable_signup": false
--
-- Email/password signup is enabled on a project whose products never use it. So
-- the path is: POST /auth/v1/signup with the public key, confirm through a
-- disposable inbox (`mailer_autoconfirm` is false, so confirmation is required
-- but is exactly the step throwaway-mail services automate), sign in, call this
-- function, collect $1. It never touches our UI, so no amount of client-side
-- hardening would have seen it. Measured 2026-08-28: 23 claims, $23.
--
-- WHY A DATABASE RULE AND NOT JUST THE DASHBOARD TOGGLE. Turning the Email
-- provider off closes this today and is being done as well. But that setting
-- lives only in the dashboard: it is absent from `supabase/config.toml` (whose
-- `[auth]` block is the LOCAL stack's), invisible to code review, and re-enabling
-- it would silently reopen the hole with nothing in the repo to show for it. A
-- payout rule belongs next to the payout.
--
-- WHY "HAS A NON-EMAIL IDENTITY" AND NOT AN ALLOWLIST. The obvious form is
-- `provider IN ('google','github','discord')`. Enabling a fourth provider later
-- would then silently stop paying the trial credit for it, and a grant that
-- quietly does not happen is close to undiagnosable — nobody files a bug saying
-- "I did not receive a dollar I did not know about". The negative test says what
-- we actually mean: the account must have been created by a real identity
-- provider, whichever ones we happen to offer.
--
-- `auth.identities` rather than `raw_app_meta_data->>'provider'`: the latter
-- records only the PRIMARY provider, so an OAuth user who later linked an email
-- would read as eligible or ineligible depending on ordering. The identities
-- table has a row per linked provider and answers the question directly.
--
-- NOBODY LOSES A CREDIT THEY ALREADY HAVE. `ON CONFLICT` already prevented a
-- second grant, so every existing balance is untouched; this only changes who is
-- eligible from here.
--
-- The refusal returns `ok: true` with `granted: false`, not an error.
-- `auth_handlers.ts` caches a successful result and retries a failed one, and a
-- permanently ineligible account should not be retried on every session check.
--
-- The body below is otherwise UNCHANGED. In particular `ON CONFLICT (kind, ref)`
-- is left exactly as it is: that clause once failed to match a PARTIAL index and
-- raised 42P10 on every wallet write — trial, top-up and debit alike — silently,
-- for long enough that Core was billing nothing. See 20260714140000.

CREATE OR REPLACE FUNCTION public.claim_signup_credit()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  bal bigint;
  has_identity boolean;
BEGIN
  IF uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;

  -- Schema-qualified on purpose: `search_path` is pinned to `public` above.
  SELECT EXISTS (
    SELECT 1 FROM auth.identities
    WHERE user_id = uid AND provider <> 'email'
  ) INTO has_identity;

  IF NOT has_identity THEN
    SELECT balance_cents INTO bal FROM credit_wallet WHERE user_id = uid;
    RETURN jsonb_build_object(
      'ok', true,
      'balance_cents', COALESCE(bal, 0),
      'granted', false,
      'reason', 'ineligible_provider'
    );
  END IF;

  INSERT INTO credit_wallet (user_id) VALUES (uid) ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO credit_transactions (user_id, delta_cents, kind, ref)
  VALUES (uid, 100, 'trial', uid::text)
  ON CONFLICT (kind, ref) DO NOTHING;
  IF NOT FOUND THEN
    SELECT balance_cents INTO bal FROM credit_wallet WHERE user_id = uid;
    RETURN jsonb_build_object('ok', true, 'balance_cents', bal, 'already_claimed', true);
  END IF;

  UPDATE credit_wallet
  SET balance_cents = balance_cents + 100, updated_at = now()
  WHERE user_id = uid
  RETURNING balance_cents INTO bal;

  RETURN jsonb_build_object('ok', true, 'balance_cents', bal, 'granted', true);
END;
$$;

-- MANDATORY after CREATE OR REPLACE: Postgres re-adds the default PUBLIC grant,
-- so a migration written to narrow this function would otherwise widen it. This
-- is the trap 20260714150000 exists to record — `credit_wallet_service` was
-- callable by anon for the same reason.
REVOKE EXECUTE ON FUNCTION public.claim_signup_credit() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_signup_credit() FROM anon;
GRANT EXECUTE ON FUNCTION public.claim_signup_credit() TO authenticated;
