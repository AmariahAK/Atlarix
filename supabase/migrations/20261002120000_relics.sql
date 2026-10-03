-- Relics: pages the agent makes to share (a design before building, an
-- explainer, a report). Hosted ones are paid Core only; BYOK and free Auto
-- write a local file instead and never reach these tables.
--
-- WHERE THE BYTES ARE. Not here: the files live in Cloudflare R2
-- (`r/<id>/v<n>/<path>`), served by the relics.atlarix.dev Worker from a site
-- that is not atlarix.dev. These tables hold who owns what, its title and
-- sharing, and which version is current — a few hundred bytes per relic.
--
-- WHO TOUCHES THEM. Only the `relics` edge function, with the service role.
-- It checks the caller's JWT itself and decides who may view: the owner, or
-- anyone with the link once it is shared. RLS is on with no policies, and every
-- client role is revoked, so nothing reaches these tables any other way.
--
-- CAPS (enforced in the function): 200 relics per user, 50 files and 5 MB per
-- version.

CREATE TABLE IF NOT EXISTS public.relics (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  kind text NOT NULL DEFAULT 'page' CHECK (kind IN ('page', 'design')),
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'link')),
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  bytes integer NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS relics_user_updated ON public.relics (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.relic_versions (
  relic_id text NOT NULL REFERENCES public.relics (id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  bytes integer NOT NULL CHECK (bytes >= 0),
  files integer NOT NULL CHECK (files >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (relic_id, version)
);

ALTER TABLE public.relics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.relic_versions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.relics FROM PUBLIC;
REVOKE ALL ON public.relics FROM authenticated, anon;
REVOKE TRUNCATE, MAINTAIN ON public.relics FROM service_role;
REVOKE ALL ON public.relic_versions FROM PUBLIC;
REVOKE ALL ON public.relic_versions FROM authenticated, anon;
REVOKE TRUNCATE, MAINTAIN ON public.relic_versions FROM service_role;

-- Check after applying:
--   SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
--    WHERE table_name IN ('relics', 'relic_versions') ORDER BY 1, 2, 3;
-- Expect service_role only (no TRUNCATE / MAINTAIN), nothing for anon/authenticated.
