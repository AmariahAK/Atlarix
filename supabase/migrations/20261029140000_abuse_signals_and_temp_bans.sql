-- 2026-10-29: abuse signals, automatic temporary bans and the sign-up check.
--
-- The 2026-10-28 attacker fuzzed for seven hours because nothing counted
-- refusals per account, nothing could ban an account without a person running
-- SQL, and a throwaway domain (`6gdfg.zone.id`, which IS on the public
-- disposable-domain list) could sign up like anyone else. This adds:
--
--  1. `user_bans.kind` / `expires_at`: a ban can be automatic and temporary.
--  2. `abuse_events`: signals that are not requests (a forged webhook, a hook
--     refusal); `signup_attempts`: every sign-up decision, 7 days.
--  3. `disposable_email_domains`: the blocklist (seeded separately, refreshed by
--     scripts/refresh-disposable-domains.sh).
--  4. Service RPCs the hook and the watcher call:
--     - signup_check_service(email, ip_hash, provider) → what is known about this sign-up
--     - record_signup_attempt_service(...)
--     - set_temp_ban_service(user, reason, hours): both ban levels + the ledger row
--     - lift_ban_service(user, by)
--     - sweep_expired_temp_bans(): every 10 min (pg_cron), lifts what has run out
-- Every object here is service-role only; nothing is exposed to clients.
BEGIN;

ALTER TABLE public.user_bans
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'manual';
ALTER TABLE public.user_bans DROP CONSTRAINT IF EXISTS user_bans_kind_check;
ALTER TABLE public.user_bans ADD CONSTRAINT user_bans_kind_check CHECK (kind IN ('manual', 'auto_temp'));

CREATE TABLE IF NOT EXISTS public.abuse_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  kind         text NOT NULL CHECK (length(kind) <= 40),
  subject_kind text NOT NULL CHECK (subject_kind IN ('user', 'ip', 'domain', 'none')),
  subject      text NOT NULL DEFAULT '' CHECK (length(subject) <= 128),
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS abuse_events_at_idx ON public.abuse_events (at);
ALTER TABLE public.abuse_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.abuse_events FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.signup_attempts (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  ip_hash  text NOT NULL DEFAULT '' CHECK (ip_hash ~ '^[0-9a-f]{0,64}$'),
  domain   text NOT NULL CHECK (length(domain) <= 253),
  provider text NOT NULL DEFAULT 'email' CHECK (length(provider) <= 32),
  allowed  boolean NOT NULL,
  reason   text CHECK (reason IS NULL OR length(reason) <= 40)
);
CREATE INDEX IF NOT EXISTS signup_attempts_ip_at_idx ON public.signup_attempts (ip_hash, at);
CREATE INDEX IF NOT EXISTS signup_attempts_domain_at_idx ON public.signup_attempts (domain, at);
ALTER TABLE public.signup_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.signup_attempts FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.disposable_email_domains (
  domain   text PRIMARY KEY CHECK (domain = lower(domain) AND length(domain) <= 253),
  added_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.disposable_email_domains ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.disposable_email_domains FROM PUBLIC, anon, authenticated;

-- Mail providers whose domain is shared by millions: a burst there says
-- nothing about one person, so the per-domain limit skips them.
CREATE OR REPLACE FUNCTION public.is_major_mail_domain(p_domain text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(p_domain) = ANY (ARRAY[
    'gmail.com','googlemail.com','outlook.com','hotmail.com','live.com','msn.com','yahoo.com','ymail.com',
    'icloud.com','me.com','mac.com','proton.me','protonmail.com','pm.me','hey.com','fastmail.com',
    'yandex.com','yandex.ru','mail.com','gmx.com','gmx.de','gmx.net','web.de','qq.com','163.com','126.com',
    'aol.com','zoho.com','tutanota.com','tuta.io'
  ]);
$$;
REVOKE ALL ON FUNCTION public.is_major_mail_domain(text) FROM PUBLIC, anon, authenticated;

/** A domain is disposable when it, or any parent of it, is on the list (x.6gdfg.zone.id → 6gdfg.zone.id). */
CREATE OR REPLACE FUNCTION public.is_disposable_domain(p_domain text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  d text := lower(trim(p_domain));
  parts text[];
  i integer;
BEGIN
  IF d IS NULL OR d = '' THEN RETURN false; END IF;
  parts := string_to_array(d, '.');
  FOR i IN 1 .. array_length(parts, 1) - 1 LOOP
    IF EXISTS (SELECT 1 FROM disposable_email_domains WHERE domain = array_to_string(parts[i:], '.')) THEN
      RETURN true;
    END IF;
  END LOOP;
  RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION public.is_disposable_domain(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_disposable_domain(text) TO service_role;

/** Everything the sign-up hook needs to decide, in one call. */
CREATE OR REPLACE FUNCTION public.signup_check_service(p_email text, p_ip_hash text, p_provider text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  d text := lower(split_part(COALESCE(p_email, ''), '@', 2));
  ip text := COALESCE(p_ip_hash, '');
  ip_1h integer := 0;
  domain_24h integer := 0;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF ip <> '' THEN
    SELECT count(*) INTO ip_1h FROM signup_attempts WHERE ip_hash = ip AND at > now() - interval '1 hour';
  END IF;
  IF d <> '' AND NOT public.is_major_mail_domain(d) THEN
    SELECT count(*) INTO domain_24h FROM signup_attempts WHERE domain = d AND allowed AND at > now() - interval '24 hours';
  END IF;
  RETURN jsonb_build_object(
    'ok', true,
    'domain', d,
    'disposable', public.is_disposable_domain(d),
    'major', public.is_major_mail_domain(d),
    'ip_1h', ip_1h,
    'domain_24h', domain_24h
  );
END;
$$;
REVOKE ALL ON FUNCTION public.signup_check_service(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.signup_check_service(text, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.record_signup_attempt_service(
  p_ip_hash text, p_domain text, p_provider text, p_allowed boolean, p_reason text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RETURN; END IF;
  INSERT INTO signup_attempts (ip_hash, domain, provider, allowed, reason)
  VALUES (COALESCE(p_ip_hash, ''), left(lower(COALESCE(p_domain, '')), 253), left(COALESCE(p_provider, 'email'), 32), p_allowed, left(p_reason, 40));
  IF NOT p_allowed THEN
    INSERT INTO abuse_events (kind, subject_kind, subject, detail)
    VALUES ('signup_refused', CASE WHEN COALESCE(p_ip_hash, '') <> '' THEN 'ip' ELSE 'domain' END,
            CASE WHEN COALESCE(p_ip_hash, '') <> '' THEN p_ip_hash ELSE lower(COALESCE(p_domain, '')) END,
            jsonb_build_object('reason', p_reason, 'domain', lower(COALESCE(p_domain, '')), 'provider', p_provider));
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.record_signup_attempt_service(text, text, text, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_signup_attempt_service(text, text, text, boolean, text) TO service_role;

CREATE OR REPLACE FUNCTION public.record_abuse_event_service(p_kind text, p_subject_kind text, p_subject text, p_detail jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RETURN; END IF;
  INSERT INTO abuse_events (kind, subject_kind, subject, detail)
  VALUES (left(p_kind, 40), p_subject_kind, left(COALESCE(p_subject, ''), 128), COALESCE(p_detail, '{}'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION public.record_abuse_event_service(text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_abuse_event_service(text, text, text, jsonb) TO service_role;

/** Ban at both levels for p_hours (NULL = permanent), with the ledger row. Idempotent per active ban. */
CREATE OR REPLACE FUNCTION public.set_temp_ban_service(p_user_id uuid, p_reason text, p_hours integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  until_t timestamptz := CASE WHEN p_hours IS NULL THEN NULL ELSE now() + make_interval(hours => GREATEST(p_hours, 1)) END;
  existing_until timestamptz;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM users WHERE id = p_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_such_user');
  END IF;
  SELECT expires_at INTO existing_until FROM user_bans
   WHERE user_id = p_user_id AND lifted_at IS NULL AND (expires_at IS NULL OR expires_at > now())
   ORDER BY expires_at DESC NULLS FIRST LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'expires_at', existing_until);
  END IF;
  INSERT INTO user_bans (user_id, reason, banned_by, kind, expires_at)
  VALUES (p_user_id, left(COALESCE(p_reason, 'abuse'), 300), 'abuse-watch',
          CASE WHEN until_t IS NULL THEN 'manual' ELSE 'auto_temp' END, until_t);
  UPDATE users SET banned_at = COALESCE(banned_at, now()) WHERE id = p_user_id;
  UPDATE auth.users SET banned_until = CASE WHEN until_t IS NULL THEN 'infinity'::timestamptz ELSE until_t END
   WHERE id = p_user_id;
  -- Sessions end now, not when the access token expires.
  DELETE FROM auth.refresh_tokens WHERE user_id::text = p_user_id::text;
  DELETE FROM auth.sessions WHERE user_id = p_user_id;
  RETURN jsonb_build_object('ok', true, 'expires_at', until_t);
END;
$$;
REVOKE ALL ON FUNCTION public.set_temp_ban_service(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_temp_ban_service(uuid, text, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.lift_ban_service(p_user_id uuid, p_by text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE lifted integer;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  UPDATE user_bans SET lifted_at = now(), lifted_by = left(COALESCE(p_by, 'owner'), 80)
   WHERE user_id = p_user_id AND lifted_at IS NULL;
  GET DIAGNOSTICS lifted = ROW_COUNT;
  UPDATE users SET banned_at = NULL WHERE id = p_user_id;
  UPDATE auth.users SET banned_until = NULL WHERE id = p_user_id;
  RETURN jsonb_build_object('ok', true, 'lifted', lifted);
END;
$$;
REVOKE ALL ON FUNCTION public.lift_ban_service(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lift_ban_service(uuid, text) TO service_role;

/** Lift what has run out; a user with another active ban stays banned. */
CREATE OR REPLACE FUNCTION public.sweep_expired_temp_bans()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  r record;
  n integer := 0;
BEGIN
  FOR r IN
    UPDATE user_bans SET lifted_at = now(), lifted_by = 'expired'
     WHERE kind = 'auto_temp' AND lifted_at IS NULL AND expires_at IS NOT NULL AND expires_at <= now()
     RETURNING user_id
  LOOP
    IF NOT EXISTS (SELECT 1 FROM user_bans WHERE user_id = r.user_id AND lifted_at IS NULL) THEN
      UPDATE users SET banned_at = NULL WHERE id = r.user_id;
      UPDATE auth.users SET banned_until = NULL WHERE id = r.user_id AND (banned_until IS NULL OR banned_until <> 'infinity');
    END IF;
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.sweep_expired_temp_bans() FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('sweep-expired-temp-bans', '*/10 * * * *', $job$ SELECT public.sweep_expired_temp_bans() $job$);
SELECT cron.schedule('signup-attempts-retention', '23 3 * * *', $job$ DELETE FROM public.signup_attempts WHERE at < now() - interval '7 days' $job$);
SELECT cron.schedule('abuse-events-retention', '29 3 * * *', $job$ DELETE FROM public.abuse_events WHERE at < now() - interval '90 days' $job$);

COMMIT;

-- VERIFY after applying:
--   SELECT jobname FROM cron.job WHERE jobname IN ('sweep-expired-temp-bans','signup-attempts-retention','abuse-events-retention');
--   SELECT public.is_disposable_domain('x.6gdfg.zone.id');  -- true once the list is seeded
--   SELECT table_name FROM information_schema.role_table_grants WHERE grantee IN ('anon','authenticated')
--     AND table_name IN ('abuse_events','signup_attempts','disposable_email_domains');  -- no rows
