-- Which repositories an installation actually covers.
--
-- WHY THE ACCOUNT PAGE COULD NOT SHOW THEM. It rendered "AmariahAK · selected
-- repositories" and stopped, which reads like a truncated list. It was not: the table
-- held `repository_selection` ('all' | 'selected') and nothing else, so there was no
-- list to render. The scope was named; the contents were never stored.
--
-- THE DATA WAS ALREADY ARRIVING AND BEING DISCARDED. `installation.created` carries
-- `repositories[]`, and `installation_repositories.added` / `.removed` carry
-- `repositories_added[]` / `repositories_removed[]`. The webhook parser read only
-- `installation.repository_selection` off those payloads and dropped the rest.
--
-- AN ARRAY, NOT A CHILD TABLE. The list is small, always read whole, never joined and
-- never queried by repo — a child table would buy nothing and cost a join on the one
-- page that reads it. `github_installs` already has an RLS policy letting a user SELECT
-- their own rows, so the column is readable by the account page with no new RPC.

ALTER TABLE public.github_installs
  ADD COLUMN IF NOT EXISTS repositories text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.github_installs.repositories IS
  'Full names ("owner/repo") this installation covers. Meaningful only when repository_selection = ''selected''; an ''all'' install is not enumerated because the set changes without an event.';

-- WHY AN RPC RATHER THAN A CLIENT-SIDE UPDATE. `added` and `removed` are DELTAS, so
-- applying them from the service means read-modify-write — and two installation
-- webhooks for the same account can be in flight at once, where the second read
-- overwrites the first write and a repository silently vanishes from the list.
-- The array math happens here, in one statement, so concurrent events compose.
--
-- A WRONG LIST IS WORSE THAN NO LIST: it tells someone a repository is covered when it
-- is not. That is the whole reason this is atomic rather than convenient.
CREATE OR REPLACE FUNCTION public.apply_install_repos_service(
  p_installation_id bigint,
  p_mode text,
  p_repos text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated int;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF p_installation_id IS NULL OR p_installation_id <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_installation');
  END IF;
  IF p_mode NOT IN ('set', 'add', 'remove') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_mode');
  END IF;

  UPDATE github_installs
     SET repositories = CASE p_mode
           -- Sorted and de-duplicated on every path so the rendered order is stable
           -- and a repeated webhook (GitHub retries) cannot double an entry.
           WHEN 'set' THEN (
             SELECT COALESCE(array_agg(DISTINCT r ORDER BY r), '{}')
               FROM unnest(COALESCE(p_repos, '{}')) AS r
           )
           WHEN 'add' THEN (
             SELECT COALESCE(array_agg(DISTINCT r ORDER BY r), '{}')
               FROM unnest(repositories || COALESCE(p_repos, '{}')) AS r
           )
           ELSE (
             SELECT COALESCE(array_agg(DISTINCT r ORDER BY r), '{}')
               FROM unnest(repositories) AS r
              WHERE r <> ALL (COALESCE(p_repos, '{}'))
           )
         END,
         updated_at = now()
   WHERE installation_id = p_installation_id;

  GET DIAGNOSTICS updated = ROW_COUNT;
  -- Not an error. The row is created when a signed-in human BINDS the installation on
  -- atlarix.dev, and the webhook can arrive first — an install nobody has bound yet has
  -- no row to update, and there is nothing to fix about that.
  RETURN jsonb_build_object('ok', true, 'updated', updated);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.apply_install_repos_service(bigint, text, text[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.apply_install_repos_service(bigint, text, text[]) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_install_repos_service(bigint, text, text[]) TO service_role;
