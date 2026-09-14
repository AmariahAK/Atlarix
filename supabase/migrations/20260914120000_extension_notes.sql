-- ---------------------------------------------------------------------------
-- Notes: what Atlarix remembers about a user, synced across their devices.
-- ---------------------------------------------------------------------------
--
-- WHY THIS TABLE IS ALLOWED TO EXIST AT ALL, given the egress rule.
-- `conversation_messages` caps a `tool_label` row at 200 characters precisely
-- so page content cannot fit; that is the structural half of "page content
-- never leaves the device". Notes are 26 KB, which breaks that arithmetic --
-- and they are allowed to, because notes are about the USER. What the user
-- wanted, decided and now knows is exactly the category the rule permits to
-- leave. Where they happened to read it is not.
--
-- BUT `octet_length(body) <= 26624` IS A SIZE CAP, NOT AN EGRESS RULE, and
-- anyone who reads it as one will repeat the `## Pages and Tabs` mistake: a
-- column legitimately allowed 40,000 characters was a hole BECAUSE it was
-- legitimately large. So the egress rule is enforced in four places and only
-- three of them are here:
--
--   1. The two shape CHECKs below, which refuse the machine-recognisable forms
--      of a page dump -- the `<untrusted-data` envelope every page read arrives
--      in, and the `[e3] button` ref-line format `formatSnapshot` emits. A
--      patched client cannot get past these.
--   2. The per-user total trigger, so the table cannot become a bulk channel
--      even one legitimate-looking note at a time.
--   3. `looksCopiedFromPage` in the extension, which is the only control that
--      compares a note against what the agent actually read this turn. That
--      comparison cannot be done here; the database never sees the page.
--   4. The `remember` tool description -- now the weakest layer, not the only one.
--
-- AND THE HONEST LIMIT: Postgres cannot tell that a paragraph about someone's
-- mortgage was transcribed off their bank dashboard. What closes that residual
-- gap is not a constraint, it is that every note is listed, readable and
-- deletable by the user on the launchpad. A hole the user can see is a hole the
-- user can close.

BEGIN;

CREATE TABLE IF NOT EXISTS public.extension_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  title text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  type text NOT NULL DEFAULT 'user',
  body text NOT NULL DEFAULT '',
  -- Monotonic, server-assigned. The compare-and-swap key; see the RPC below.
  rev bigint NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT extension_notes_name_shape
    CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  CONSTRAINT extension_notes_title_length
    CHECK (char_length(title) <= 48),
  CONSTRAINT extension_notes_description_length
    CHECK (char_length(description) <= 96),
  CONSTRAINT extension_notes_type_known
    CHECK (type IN ('project', 'feedback', 'reference', 'user')),
  CONSTRAINT extension_notes_body_bytes
    CHECK (octet_length(body) <= 26624),
  CONSTRAINT extension_notes_rev_positive
    CHECK (rev >= 1),

  -- A tombstone must not keep its text. Without this, "delete" would leave the
  -- content on the server after the user asked for it to be gone -- which is
  -- the opposite of what they clicked.
  CONSTRAINT extension_notes_tombstone_is_empty
    CHECK (deleted_at IS NULL OR body = ''),

  -- The egress shape checks. Both target bytes a copy-paste produces and that
  -- prose about a person does not.
  CONSTRAINT extension_notes_not_a_page_envelope
    CHECK (position('<untrusted-data' in body) = 0),
  CONSTRAINT extension_notes_not_a_page_snapshot
    CHECK (
      (length(body) - length(replace(body, E'\n[', E'\n'))) <= 3
      OR body !~ E'\n\\[[a-z]?[0-9]+\\] '
    )
);

-- THE NATURAL KEY, and the conflict target. Two devices that independently
-- create "preferences" must CONVERGE on one row, not produce two -- which is
-- what a device-generated uuid PK would have done here. This differs from
-- `conversations`, where a device-generated id genuinely IS the identity.
CREATE UNIQUE INDEX IF NOT EXISTS extension_notes_user_name_idx
  ON public.extension_notes (user_id, name);

CREATE INDEX IF NOT EXISTS extension_notes_user_updated_idx
  ON public.extension_notes (user_id, updated_at DESC);

-- ---------------------------------------------------------------------------
-- Per-user totals, enforced where a patched client cannot reach.
-- ---------------------------------------------------------------------------
-- The client has the same numbers in `memory/limits.ts`. Both halves exist for
-- the reason `sessions/sync.ts` already states about its own clipping: either
-- one alone holds only until someone writes a second caller.
CREATE OR REPLACE FUNCTION public.extension_notes_enforce_totals()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  total_bytes bigint;
  live_count bigint;
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN RETURN NEW; END IF;

  SELECT COALESCE(SUM(octet_length(body)), 0), COUNT(*)
    INTO total_bytes, live_count
    FROM public.extension_notes
   WHERE user_id = NEW.user_id
     AND deleted_at IS NULL
     AND id <> NEW.id;

  IF total_bytes + octet_length(NEW.body) > 524288 THEN
    RAISE EXCEPTION 'notes_total_exceeded';
  END IF;
  IF live_count + 1 > 30 THEN
    RAISE EXCEPTION 'notes_count_exceeded';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS extension_notes_totals ON public.extension_notes;
CREATE TRIGGER extension_notes_totals
  BEFORE INSERT OR UPDATE ON public.extension_notes
  FOR EACH ROW EXECUTE FUNCTION public.extension_notes_enforce_totals();

-- THE TRIGGER FUNCTION NEEDS THE REVOKE TOO, and it was missed on the first
-- pass — caught by the `proacl` read-back below, which is exactly what that
-- read-back is for. `CREATE FUNCTION` grants EXECUTE to PUBLIC by default, and
-- this one had it while every other function in the file did not.
--
-- It is harmless in practice: Postgres refuses a direct call to a trigger
-- function ("trigger functions can only be called as triggers"), verified
-- against the live database. It is revoked anyway, because the check below is
-- stated as "no function may show an empty grantee" and a rule with one
-- remembered exception is a rule the next person applies wrongly. Revoking
-- after the fact does not break the trigger — EXECUTE is checked at CREATE
-- TRIGGER time, not at firing time; also verified.
REVOKE EXECUTE ON FUNCTION public.extension_notes_enforce_totals()
  FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- RLS, and the grants without which every policy above is unreachable.
-- ---------------------------------------------------------------------------
ALTER TABLE public.extension_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "extension_notes_select_own" ON public.extension_notes
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- SELECT ONLY. Every write goes through the RPC below, because a direct write
-- cannot express the compare-and-swap and would silently reintroduce
-- last-write-wins for anyone who called PostgREST directly.
-- NAME EVERY PRIVILEGE, NOT JUST THE FOUR OBVIOUS ONES. Supabase's default
-- privileges grant `arwdDxtm` — all of them — on every new table in `public` to
-- anon, authenticated and service_role. Revoking only INSERT/UPDATE/DELETE
-- leaves TRUNCATE, and **TRUNCATE IS NOT FILTERED BY ROW SECURITY**: an
-- authenticated role holding it can empty the whole table regardless of every
-- policy above. Verified against the live database, where it succeeded before
-- this line existed and is refused after it.
--
-- Not currently reachable — PostgREST has no TRUNCATE verb and the role is not
-- directly connectable — but it is one bug away from total data loss, which is
-- the definition of a thing to revoke rather than to reason about.
GRANT SELECT ON public.extension_notes TO authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.extension_notes FROM authenticated;
REVOKE ALL ON public.extension_notes FROM anon;

-- ---------------------------------------------------------------------------
-- The ONE write path: compare-and-swap on `rev`.
-- ---------------------------------------------------------------------------
-- WHY NOT LAST-WRITE-WINS ON `updated_at`. It resolves conflicts by whose clock
-- is faster. A browser profile's clock and a laptop's skew by real, unbounded
-- amounts, the "winner" is arbitrary, and nobody is told. `rev` is monotonic and
-- server-assigned, so it compares without trusting any client's sense of time.
--
-- WHY NOT `Prefer: resolution=merge-duplicates`, which is what `sync.ts` uses
-- for conversations: it is an UNCONDITIONAL overwrite and cannot express a CAS
-- at all. A transcript has one writer and is append-only; a note has two
-- writers -- the extension and the launchpad -- and they edit the same field.
--
-- BOTH SURFACES CALL THIS. Two write paths would mean the CAS holds on one of
-- them, which is the same failure class as a policy without a grant: correct
-- looking, silently ineffective.
CREATE OR REPLACE FUNCTION public.save_extension_note(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  v_name text := p_input->>'name';
  v_rev bigint := COALESCE((p_input->>'rev')::bigint, 0);
  existing public.extension_notes%ROWTYPE;
  saved public.extension_notes%ROWTYPE;
BEGIN
  IF uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;
  IF v_name IS NULL OR v_name !~ '^[a-z0-9][a-z0-9-]{0,31}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_name');
  END IF;

  SELECT * INTO existing FROM public.extension_notes
   WHERE user_id = uid AND name = v_name FOR UPDATE;

  IF FOUND THEN
    -- A push carrying a rev older than what is stored is a device that has not
    -- pulled. Refused, and the CURRENT row is handed back so the caller can
    -- show the user both versions rather than silently discarding one.
    IF v_rev < existing.rev THEN
      RETURN jsonb_build_object(
        'ok', false, 'reason', 'stale', 'rev', existing.rev,
        'note', to_jsonb(existing)
      );
    END IF;

    UPDATE public.extension_notes SET
      title = COALESCE(p_input->>'title', title),
      description = COALESCE(p_input->>'description', description),
      type = COALESCE(p_input->>'type', type),
      body = COALESCE(p_input->>'body', body),
      -- A write to a tombstoned note RESURRECTS it. A tombstone is not a
      -- permanent grave: refusing would fail a write the model was correctly
      -- told it could make, and the other side sees the note reappear with new
      -- content, which is honest and undoable with one click.
      deleted_at = NULL,
      rev = existing.rev + 1,
      updated_at = now()
    WHERE id = existing.id
    RETURNING * INTO saved;
  ELSE
    INSERT INTO public.extension_notes
      (user_id, name, title, description, type, body, rev)
    VALUES (
      uid, v_name,
      COALESCE(p_input->>'title', ''),
      COALESCE(p_input->>'description', ''),
      COALESCE(p_input->>'type', 'user'),
      COALESCE(p_input->>'body', ''),
      1
    )
    RETURNING * INTO saved;
  END IF;

  RETURN jsonb_build_object('ok', true, 'rev', saved.rev, 'note', to_jsonb(saved));
EXCEPTION
  -- The trigger's own signals, turned into results rather than raised. Every
  -- caller here is best-effort sync or a form; neither should see a 500.
  WHEN raise_exception THEN
    RETURN jsonb_build_object('ok', false, 'reason', SQLERRM);
  WHEN check_violation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'rejected', 'detail', SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_extension_note(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  v_name text := p_input->>'name';
BEGIN
  IF uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;

  -- TOMBSTONE, NEVER A ROW DELETE. A hard delete lets the other device
  -- resurrect the note on its next push, which reads as the product refusing to
  -- forget. The body is cleared in the same statement, enforced by the CHECK.
  UPDATE public.extension_notes
     SET deleted_at = now(), body = '', rev = rev + 1, updated_at = now()
   WHERE user_id = uid AND name = v_name AND deleted_at IS NULL;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants, re-issued because CREATE OR REPLACE re-grants EXECUTE to PUBLIC.
-- ---------------------------------------------------------------------------
-- Recorded from the 2026-07 Supabase remediation. VERIFY BY READING `proacl`
-- BACK after applying -- the CLI saying "up to date" proves only that it ran
-- the file, not what the ACL now says. Neither may list an empty grantee.
--
--   SELECT p.proname, p.proacl FROM pg_proc p
--     JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.proname IN ('save_extension_note', 'delete_extension_note');
REVOKE EXECUTE ON FUNCTION public.save_extension_note(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_extension_note(jsonb) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.delete_extension_note(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_extension_note(jsonb) TO authenticated;

COMMIT;
