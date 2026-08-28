-- Binding a GitHub App installation to an Atlarix account, and the one grant
-- /account needs to read its own ledger.
--
-- WHY AN RPC AND NOT A CLIENT INSERT. `20260825120000` revokes
-- INSERT/UPDATE/DELETE on `github_installs` from `authenticated` and grants only
-- SELECT, deliberately: the existence of a row IS the entitlement, so a browser
-- that could write one could grant itself reviews. A direct client insert does
-- not merely fail, it fails as an RLS error that reads like a broken policy.
--
-- WHY SERVICE-ROLE ONLY. The caller must PROVE it controls the installation
-- before this is reached, and that proof cannot be done in Postgres: it requires
-- exchanging a GitHub OAuth code and calling `GET /user/installations`. That
-- happens in the `bind-github-install` edge function, which holds the App's
-- client secret. This function is the last step, not the check.

-- ---------------------------------------------------------------------------
-- 1. bind_github_install_service
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bind_github_install_service(
  p_user_id uuid,
  p_installation_id bigint,
  p_account_login text DEFAULT NULL,
  p_repository_selection text DEFAULT NULL
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

  SELECT user_id INTO existing_owner
  FROM github_installs WHERE installation_id = p_installation_id FOR UPDATE;

  -- ALREADY OWNED BY SOMEONE ELSE: refuse, loudly, rather than reassigning.
  --
  -- `installation_id` is the PRIMARY KEY, so an unguarded upsert would silently
  -- MOVE the installation to whoever bound it last — every review on those
  -- repositories then bills a different account, and the previous owner's bot
  -- goes quiet with nothing to explain it. A takeover has to be an explicit,
  -- human act (uninstall and reinstall), never a side effect of visiting a URL.
  IF existing_owner IS NOT NULL AND existing_owner <> p_user_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'installation_already_bound');
  END IF;

  INSERT INTO github_installs (
    installation_id, user_id, account_login, repository_selection, removed_at
  )
  VALUES (p_installation_id, p_user_id, p_account_login, p_repository_selection, NULL)
  ON CONFLICT (installation_id) DO UPDATE
  SET user_id = EXCLUDED.user_id,
      account_login = COALESCE(EXCLUDED.account_login, github_installs.account_login),
      repository_selection =
        COALESCE(EXCLUDED.repository_selection, github_installs.repository_selection),
      -- Re-binding revives a previously removed install. Someone who uninstalled
      -- and reinstalled is reconnecting, not resurrecting stale state.
      removed_at = NULL,
      updated_at = now();

  RETURN jsonb_build_object(
    'ok', true, 'installation_id', p_installation_id, 'rebound', existing_owner IS NOT NULL
  );
END;
$$;

-- CREATE OR REPLACE re-adds the default PUBLIC EXECUTE grant on every run, and
-- revoking from authenticated/anon does not remove it. After the final
-- definition, never before.
REVOKE EXECUTE ON FUNCTION public.bind_github_install_service(uuid, bigint, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.bind_github_install_service(uuid, bigint, text, text)
  FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.bind_github_install_service(uuid, bigint, text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. The one missing table grant.
-- ---------------------------------------------------------------------------
-- `credit_transactions` has had a `credit_transactions_select_own` policy since
-- 20260714120000 and a REVOKE of INSERT/UPDATE/DELETE — but no GRANT SELECT
-- anywhere in the migration tree. The policy has never been exercised, because
-- the app reads its balance through a SECURITY DEFINER RPC that bypasses RLS
-- entirely. /account is the first thing to SELECT from this table as a user, and
-- a policy without a table-level grant matches nothing: a policy narrows rows a
-- role may ALREADY read. Measured on this project's own reviewer tables, where a
-- fresh table landed `service_role=Dxtm`.
GRANT SELECT ON public.credit_transactions TO authenticated;

-- NOT granted: credit_wallet. 20260826130000's header asserts "nothing reads
-- credit_wallet directly — checked across the app, the proxy and the reviewer",
-- and that invariant is worth keeping. The balance comes from
-- get_credit_balance, which returns the spendable total including allowances;
-- reading the table directly would show only the purchased half and quietly
-- disagree with every other surface.
