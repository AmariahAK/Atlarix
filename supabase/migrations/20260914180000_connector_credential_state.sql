-- ---------------------------------------------------------------------------
-- Let the account page tell a connected connector from an unconnected one.
-- ---------------------------------------------------------------------------
--
-- THE SYMPTOM: complete the OAuth flow against SpacInsider, land back on
-- /account, and the connector still reads "Off" with a "Connect" button. The
-- credential WAS stored -- `private.mcp_credentials` holds the row -- but the
-- page has no way to see it, so the only state it can render is the one it can
-- prove: none.
--
-- WHY THE OBVIOUS FIX IS WRONG. The reflex is a SELECT policy on the credential
-- table "just so the owner can see whether one exists". That table is
-- deliberately unreadable by its own owner: no PostgREST exposure, RLS on with
-- zero policies, grants to `service_role` only. That property is the whole
-- point of keeping tokens server-side, and it should not be traded for a badge.
-- `docs/TODO.md` wrote this down as a rule before the table existed -- "put
-- expiry on `account_mcp_servers` as a derived column instead" -- and then the
-- column was never added, which is how a UI ends up unable to describe a state
-- that plainly exists.
--
-- WHAT IS PUBLISHED IS NOT THE CREDENTIAL. Three facts, none of them secret:
-- whether one is set, when it expires, and whether a refresh token came with
-- it. A ciphertext, a nonce and a key version remain unreadable.
--
-- THE THIRD COLUMN IS NOT PADDING. An expired credential WITH a refresh token
-- is not a problem -- the proxy refreshes it lazily on the next call -- so a UI
-- that said "Reconnect" on expiry alone would be nagging about something
-- already handled. Without a refresh token, expiry genuinely means reconnect.
-- Those are different states and the page cannot tell them apart from a
-- timestamp.
--
-- ══ A TRIGGER, NOT THREE CALL SITES ══
--
-- The credential is written by `mcp_credential_put_service`, deleted by
-- `mcp_credential_clear_service`, deleted again by `upsert_account_mcp_server`
-- when the URL or auth kind changes, and deleted a fourth time by the FK
-- cascade when the connector is removed. Updating the derived columns at each
-- of those is four chances to miss one, and the miss is silent -- a badge that
-- says "Connected" about a credential that is gone.
--
-- So the source of truth maintains its own shadow. Any path that writes
-- `private.mcp_credentials` is correct by construction, including paths not
-- written yet.

BEGIN;

ALTER TABLE public.account_mcp_servers
  ADD COLUMN IF NOT EXISTS credential_set_at timestamptz,
  ADD COLUMN IF NOT EXISTS credential_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS credential_has_refresh boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.account_mcp_servers.credential_set_at IS
  'Non-null when a credential exists in private.mcp_credentials. Derived by trigger; never written directly.';

CREATE OR REPLACE FUNCTION private.mcp_credential_mirror()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Matches nothing when the connector itself is being deleted (the FK
    -- cascade fires this on the way down), which is the desired no-op.
    UPDATE public.account_mcp_servers SET
      credential_set_at = NULL,
      credential_expires_at = NULL,
      credential_has_refresh = false
    WHERE id = OLD.server_id;
    RETURN OLD;
  END IF;

  UPDATE public.account_mcp_servers SET
    -- COALESCE, NOT `now()`. A lazy refresh rewrites the credential row every
    -- time a token expires, and `mcp_credentials` keeps only `updated_at` -- so
    -- taking the current time here would make "connected since" move every
    -- hour, which is not a fact about connecting. The first value sticks until
    -- the credential is actually cleared, which is when the DELETE branch nulls
    -- it.
    credential_set_at = COALESCE(credential_set_at, now()),
    credential_expires_at = NEW.expires_at,
    credential_has_refresh = NEW.has_refresh
  WHERE id = NEW.server_id;
  RETURN NEW;
END;
$$;

-- CREATE FUNCTION grants EXECUTE to PUBLIC by default, and a trigger function
-- is no exception -- this was caught on `extension_notes_enforce_totals` by the
-- `proacl` read-back and is revoked here before it can be. Postgres refuses a
-- direct call to a trigger function anyway; the rule is stated as "no function
-- may show an empty grantee", and a rule with one remembered exception is a
-- rule the next person applies wrongly. Revoking does not break the trigger:
-- EXECUTE is checked at CREATE TRIGGER time, not at firing time.
REVOKE EXECUTE ON FUNCTION private.mcp_credential_mirror()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS mcp_credentials_mirror ON private.mcp_credentials;
CREATE TRIGGER mcp_credentials_mirror
  AFTER INSERT OR UPDATE OR DELETE ON private.mcp_credentials
  FOR EACH ROW EXECUTE FUNCTION private.mcp_credential_mirror();

-- Backfill. The SpacInsider connector was connected before this migration
-- existed and its row is the reason this file was written; leaving it looking
-- unconnected would mean the fix did not fix the case that produced it.
-- `updated_at` is the only timestamp the credential row carries. For a
-- connector that has never refreshed it IS the moment it was connected; for one
-- that has, it is the last refresh. Close enough for a backfill, and every row
-- from here on gets the real thing from the trigger.
UPDATE public.account_mcp_servers s SET
  credential_set_at = c.updated_at,
  credential_expires_at = c.expires_at,
  credential_has_refresh = c.has_refresh
FROM private.mcp_credentials c
WHERE c.server_id = s.id;

COMMIT;
