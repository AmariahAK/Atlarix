-- Throwaway mail domains are LEARNED, not only listed (owner, 2026-10-30: "a more
-- dynamic way of finding domains without hardcoding, where it picks it up and
-- adds it on its own").
--
-- What a sign-up now records: the domain's mail host, whether the domain has a
-- website, and how old it is (when RDAP answers). What the system learns from it:
--  - a domain the hook judged a throwaway goes on the list itself (source 'auto');
--  - its mail host goes on `disposable_mx_hosts`, so the NEXT fresh domain on the
--    same mail infrastructure is refused on sight (parcel.lat, fieldwork.lat, …
--    each ran its own mx.<domain>; burner services behind one host are caught
--    the second time);
--  - the same network signing up on another fresh no-website domain within a
--    week is the burner pattern: both domains are listed.
-- The watcher (abuse-watch) applies the same rule after the fact to accounts the
-- hook let through, bans them for 24 h with a lift link, and lists their domains.
-- Every object is service-role only.
BEGIN;

ALTER TABLE public.disposable_email_domains
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'list' CHECK (source IN ('list', 'manual', 'auto')),
  ADD COLUMN IF NOT EXISTS reason text CHECK (length(reason) <= 120);

ALTER TABLE public.signup_attempts
  ADD COLUMN IF NOT EXISTS mx_host text CHECK (length(mx_host) <= 253),
  ADD COLUMN IF NOT EXISTS has_web boolean,
  ADD COLUMN IF NOT EXISTS domain_age_days integer;

CREATE TABLE IF NOT EXISTS public.disposable_mx_hosts (
  host        text PRIMARY KEY CHECK (length(host) <= 253),
  from_domain text NOT NULL,
  added_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.disposable_mx_hosts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.disposable_mx_hosts FROM PUBLIC, anon, authenticated;

/**
 * Mail hosts that many unrelated, legitimate domains share. A throwaway domain
 * on one of these teaches us nothing about the host, so it is never learned.
 */
CREATE OR REPLACE FUNCTION public.is_shared_mail_host(p_host text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(p_host) ~ '(google\.com|googlemail\.com|outlook\.com|protection\.outlook|hotmail\.com|yahoodns\.net|icloud\.com|apple\.com|protonmail\.ch|proton\.me|zoho\.(com|eu|in)|fastmail\.com|messagingengine\.com|yandex\.(net|ru)|mail\.ru|qq\.com|163\.com|126\.com|mimecast\.com|pphosted\.com|messagelabs\.com|barracudanetworks\.com|secureserver\.net|emailsrvr\.com|hostinger\.com|ionos\.(com|de)|1and1\.(com|de)|ovh\.net|mailgun\.org|sendgrid\.net|improvmx\.com|forwardemail\.net|mx\.cloudflare\.net|mxrecord\.io|registrar-servers\.com|privateemail\.com|titan\.email|namecheap\.com|dreamhost\.com|bluehost\.com|hostgator\.com|siteground\.(com|net)|mailspamprotection\.com|amazonaws\.com|mailchannels\.net)$';
$$;

/** Put a domain on the list because the system judged it, and learn its mail host when that host is its own. */
CREATE OR REPLACE FUNCTION public.learn_throwaway_domain_service(p_domain text, p_mx_host text, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  d text := lower(COALESCE(p_domain, ''));
  h text := lower(COALESCE(p_mx_host, ''));
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RETURN; END IF;
  IF d = '' OR public.is_major_mail_domain(d) THEN RETURN; END IF;
  INSERT INTO disposable_email_domains (domain, source, reason) VALUES (d, 'auto', left(p_reason, 120))
  ON CONFLICT (domain) DO NOTHING;
  IF h <> '' AND NOT public.is_shared_mail_host(h) THEN
    INSERT INTO disposable_mx_hosts (host, from_domain) VALUES (h, d) ON CONFLICT (host) DO NOTHING;
  END IF;
  INSERT INTO abuse_events (kind, subject_kind, subject, detail)
  VALUES ('domain_learned', 'domain', d, jsonb_build_object('reason', p_reason, 'mx_host', h));
END;
$$;
REVOKE ALL ON FUNCTION public.learn_throwaway_domain_service(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.learn_throwaway_domain_service(text, text, text) TO service_role;

/** The sign-up check, now with the learned signals. Old 3-argument form stays for the deployed hook. */
DROP FUNCTION IF EXISTS public.signup_check_service(text, text, text);
CREATE OR REPLACE FUNCTION public.signup_check_service(p_email text, p_ip_hash text, p_provider text, p_mx_host text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  d text := lower(split_part(COALESCE(p_email, ''), '@', 2));
  ip text := COALESCE(p_ip_hash, '');
  h text := lower(COALESCE(p_mx_host, ''));
  ip_1h integer := 0;
  domain_24h integer := 0;
  ip_domains_7d integer := 0;
  ip_noweb_7d integer := 0;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF ip <> '' THEN
    SELECT count(*) INTO ip_1h FROM signup_attempts WHERE ip_hash = ip AND at > now() - interval '1 hour';
    -- Other, non-major domains this network signed up with in the last week.
    SELECT count(DISTINCT domain), count(DISTINCT domain) FILTER (WHERE has_web IS FALSE)
      INTO ip_domains_7d, ip_noweb_7d
      FROM signup_attempts
     WHERE ip_hash = ip AND allowed AND domain <> d AND at > now() - interval '7 days'
       AND NOT public.is_major_mail_domain(domain);
  END IF;
  IF d <> '' AND NOT public.is_major_mail_domain(d) THEN
    SELECT count(*) INTO domain_24h FROM signup_attempts WHERE domain = d AND allowed AND at > now() - interval '24 hours';
  END IF;
  RETURN jsonb_build_object(
    'ok', true,
    'disposable', public.is_disposable_domain(d),
    'major', public.is_major_mail_domain(d),
    'ip_1h', ip_1h,
    'domain_24h', domain_24h,
    'ip_domains_7d', ip_domains_7d,
    'ip_noweb_7d', ip_noweb_7d,
    'mx_known', (h <> '' AND EXISTS (SELECT 1 FROM disposable_mx_hosts WHERE host = h)),
    'mx_shared', (h <> '' AND public.is_shared_mail_host(h))
  );
END;
$$;
REVOKE ALL ON FUNCTION public.signup_check_service(text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.signup_check_service(text, text, text, text) TO service_role;

DROP FUNCTION IF EXISTS public.record_signup_attempt_service(text, text, text, boolean, text);
CREATE OR REPLACE FUNCTION public.record_signup_attempt_service(
  p_ip_hash text, p_domain text, p_provider text, p_allowed boolean, p_reason text,
  p_mx_host text DEFAULT NULL, p_has_web boolean DEFAULT NULL, p_domain_age_days integer DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RETURN; END IF;
  INSERT INTO signup_attempts (ip_hash, domain, provider, allowed, reason, mx_host, has_web, domain_age_days)
  VALUES (COALESCE(p_ip_hash, ''), left(lower(COALESCE(p_domain, '')), 253), left(COALESCE(p_provider, 'email'), 32), p_allowed, left(p_reason, 40),
          left(lower(p_mx_host), 253), p_has_web, p_domain_age_days);
  IF NOT p_allowed THEN
    INSERT INTO abuse_events (kind, subject_kind, subject, detail)
    VALUES ('signup_refused', CASE WHEN COALESCE(p_ip_hash, '') <> '' THEN 'ip' ELSE 'domain' END,
            CASE WHEN COALESCE(p_ip_hash, '') <> '' THEN p_ip_hash ELSE lower(COALESCE(p_domain, '')) END,
            jsonb_build_object('reason', p_reason, 'domain', lower(COALESCE(p_domain, '')), 'provider', p_provider));
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.record_signup_attempt_service(text, text, text, boolean, text, text, boolean, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_signup_attempt_service(text, text, text, boolean, text, text, boolean, integer) TO service_role;

/** The public blocklist, re-pulled weekly so new throwaway services arrive without a hand edit. */
CREATE OR REPLACE FUNCTION public.refresh_disposable_domains()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public, extensions' AS $$
DECLARE
  body text;
  n integer := 0;
BEGIN
  SELECT content INTO body FROM extensions.http_get('https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf');
  IF body IS NULL OR length(body) < 10000 THEN RETURN 0; END IF;
  WITH lines AS (
    SELECT lower(trim(l)) AS domain FROM regexp_split_to_table(body, E'\n') AS l
  ), ins AS (
    INSERT INTO disposable_email_domains (domain, source)
    SELECT domain, 'list' FROM lines WHERE domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'
    ON CONFLICT (domain) DO NOTHING RETURNING 1
  ) SELECT count(*) INTO n FROM ins;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.refresh_disposable_domains() FROM PUBLIC, anon, authenticated;
SELECT cron.unschedule('refresh-disposable-domains') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-disposable-domains');
SELECT cron.schedule('refresh-disposable-domains', '17 4 * * 1', $job$ SELECT public.refresh_disposable_domains() $job$);

-- Mark the domains the owner listed by hand today.
UPDATE public.disposable_email_domains SET source = 'manual', reason = 'owner 2026-10-30: burner domain, same network' WHERE domain IN ('parcel.lat', 'fieldwork.lat');
-- And learn their mail hosts (their own: mx.<domain>), as the hook would have.
INSERT INTO public.disposable_mx_hosts (host, from_domain) VALUES ('mx.parcel.lat', 'parcel.lat'), ('mx.fieldwork.lat', 'fieldwork.lat') ON CONFLICT DO NOTHING;

COMMIT;
