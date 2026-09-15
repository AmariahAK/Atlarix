-- ---------------------------------------------------------------------------
-- A write to a DELETED note must not be refused as stale.
-- ---------------------------------------------------------------------------
--
-- `save_extension_note` already resurrects a tombstone -- but only after the
-- compare-and-swap, and the CAS is what a resurrecting write fails. A note's
-- identity is `(user_id, name)`, so a deleted row keeps its name and its `rev`.
-- Any writer that has not seen the delete -- a launchpad "Add a note" form,
-- which sends `rev: 0` because from its side the note is new, or an extension
-- whose last pull predates the delete -- sends a rev lower than the tombstone's
-- and is told "this changed somewhere else -- reload".
--
-- RELOADING DOES NOT HELP. `useNotes` filters `deleted_at IS NULL`, so the row
-- the user is colliding with is invisible to them; the name is unusable and the
-- page cannot say why. The extension's version is worse: a `stale` rejection
-- writes the server's copy as a `-from-web` sibling, and the server's copy of a
-- tombstone is an EMPTY BODY, so the user gets a blank note and is told to
-- merge it.
--
-- THE CAS PROTECTS PROSE, AND A TOMBSTONE HAS NONE. `extension_notes_tombstone_
-- is_empty` guarantees a deleted row's body is `''`. There is nothing for a
-- concurrent write to overwrite, so refusing one protects nothing and costs a
-- name. Resurrection is visible in both surfaces and undone with one click.
--
-- The live check stays exactly as it was: two editors of a note that EXISTS
-- still collide on `rev`, and the loser still gets its sibling.
--
-- Only the `IF FOUND` branch's first statement changes; the rest of the body is
-- reproduced verbatim because `CREATE OR REPLACE` has no partial form.

BEGIN;

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
    --
    -- UNLESS THE ROW IS A TOMBSTONE. A deleted note is guaranteed empty, so
    -- there is no version to show and nothing to lose; the write resurrects it
    -- below. See this migration's header.
    IF v_rev < existing.rev AND existing.deleted_at IS NULL THEN
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

-- CREATE OR REPLACE re-grants EXECUTE to PUBLIC. Read `proacl` back after
-- applying; the CLI saying "up to date" proves only that it ran the file.
REVOKE EXECUTE ON FUNCTION public.save_extension_note(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_extension_note(jsonb) TO authenticated;

COMMIT;
