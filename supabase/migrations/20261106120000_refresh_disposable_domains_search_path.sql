-- The weekly blocklist re-pull never ran: `SET search_path TO 'public, extensions'`
-- names ONE schema called "public, extensions", so on 2026-11-02 04:17 UTC it failed
-- with: relation "disposable_email_domains" does not exist. Same body, schemas unquoted.
-- (Guarded by src/__tests__/migration-search-path-quoting.test.ts.)
CREATE OR REPLACE FUNCTION public.refresh_disposable_domains()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public, extensions AS $$
DECLARE
  body text;
  n integer := 0;
BEGIN
  SELECT content INTO body FROM extensions.http_get('https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf');
  IF body IS NULL OR length(body) < 10000 THEN RETURN 0; END IF;
  WITH lines AS (
    SELECT lower(trim(l)) AS domain FROM regexp_split_to_table(body, E'\n') AS l
  ), ins AS (
    INSERT INTO public.disposable_email_domains (domain, source)
    SELECT domain, 'list' FROM lines WHERE domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'
    ON CONFLICT (domain) DO NOTHING RETURNING 1
  ) SELECT count(*) INTO n FROM ins;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.refresh_disposable_domains() FROM PUBLIC, anon, authenticated;
