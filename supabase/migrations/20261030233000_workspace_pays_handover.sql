-- Workspace pays: the pot can be handed over or given up (owner, 2026-10-31):
--  - the payer (or the installer) steps down → everyone pays for themselves;
--  - the payer (or the installer) hands over to a named linked member; nothing
--    changes until that member accepts, by choosing "This account (you)";
--  - a payer whose account disappears leaves the workspace on "everyone pays"
--    (trigger), never on a mode that names nobody.
BEGIN;

ALTER TABLE public.slack_installs ADD COLUMN IF NOT EXISTS payer_handover_to uuid REFERENCES auth.users (id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION public.slack_installs_payer_consistency()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payer_user_id IS NULL THEN
    NEW.payer_mode := 'members';
    NEW.payer_handover_to := NULL;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS slack_installs_payer_consistency ON public.slack_installs;
CREATE TRIGGER slack_installs_payer_consistency BEFORE INSERT OR UPDATE ON public.slack_installs
  FOR EACH ROW EXECUTE FUNCTION public.slack_installs_payer_consistency();

DROP FUNCTION IF EXISTS public.set_slack_payer(text, text);
CREATE OR REPLACE FUNCTION public.set_slack_payer(p_team_id text, p_mode text, p_to_user_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  uid uuid := auth.uid();
  inst slack_installs%ROWTYPE;
  installer uuid;
  is_member boolean;
  may_manage boolean;
BEGIN
  IF uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated'); END IF;
  IF public.account_is_banned(uid) THEN RETURN jsonb_build_object('ok', false, 'error', 'account_banned'); END IF;
  IF p_mode NOT IN ('members', 'account') THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_mode'); END IF;
  SELECT * INTO inst FROM slack_installs WHERE team_id = p_team_id FOR UPDATE;
  IF inst.team_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_installed'); END IF;
  installer := public.slack_installer_user(p_team_id);
  is_member := EXISTS (SELECT 1 FROM slack_links WHERE team_id = p_team_id AND user_id = uid);
  IF NOT is_member AND installer IS DISTINCT FROM uid THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_a_member');
  END IF;
  may_manage := inst.payer_user_id = uid OR installer = uid;

  IF p_mode = 'members' THEN
    -- Step down: back to everyone paying for themselves.
    IF NOT may_manage THEN RETURN jsonb_build_object('ok', false, 'error', 'not_the_payer'); END IF;
    UPDATE slack_installs SET payer_user_id = NULL, payer_mode = 'members', payer_handover_to = NULL, payer_set_at = now(), updated_at = now()
     WHERE team_id = p_team_id;
    RETURN jsonb_build_object('ok', true, 'team_id', p_team_id, 'mode', 'members', 'payer_is_me', false);
  END IF;

  IF p_to_user_id IS NOT NULL AND p_to_user_id <> uid THEN
    -- Hand over: name a linked member; they must accept.
    IF NOT may_manage THEN RETURN jsonb_build_object('ok', false, 'error', 'not_the_payer'); END IF;
    IF NOT EXISTS (SELECT 1 FROM slack_links WHERE team_id = p_team_id AND user_id = p_to_user_id) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'not_a_member');
    END IF;
    UPDATE slack_installs SET payer_handover_to = p_to_user_id, updated_at = now() WHERE team_id = p_team_id;
    RETURN jsonb_build_object('ok', true, 'team_id', p_team_id, 'mode', inst.payer_mode, 'payer_is_me', inst.payer_user_id = uid, 'handover_pending', true);
  END IF;

  -- Become the payer: open when nobody pays, when it is already you, when you
  -- were handed the pot, or when you are the installer. Never a plain takeover.
  IF inst.payer_user_id IS NOT NULL AND inst.payer_user_id <> uid AND inst.payer_handover_to IS DISTINCT FROM uid AND installer IS DISTINCT FROM uid THEN
    RETURN jsonb_build_object('ok', false, 'error', 'has_payer');
  END IF;
  UPDATE slack_installs SET payer_user_id = uid, payer_mode = 'account', payer_handover_to = NULL, payer_set_at = now(), updated_at = now()
   WHERE team_id = p_team_id;
  RETURN jsonb_build_object('ok', true, 'team_id', p_team_id, 'mode', 'account', 'payer_is_me', true);
END;
$$;
REVOKE ALL ON FUNCTION public.set_slack_payer(text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_slack_payer(text, text, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_slack_pay_settings()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'team_id', i.team_id,
    'team_name', i.team_name,
    'mode', CASE WHEN i.payer_user_id IS NULL THEN 'members' ELSE i.payer_mode END,
    'payer_is_me', i.payer_user_id = auth.uid(),
    'payer_label', CASE WHEN i.payer_user_id IS NULL THEN NULL ELSE split_part((SELECT email FROM users WHERE id = i.payer_user_id), '@', 1) END,
    'can_hand_back', i.payer_user_id = auth.uid() OR public.slack_installer_user(i.team_id) = auth.uid(),
    'can_become_payer', i.payer_user_id IS NULL OR i.payer_user_id = auth.uid() OR i.payer_handover_to = auth.uid() OR public.slack_installer_user(i.team_id) = auth.uid(),
    'handover_to_me', i.payer_handover_to = auth.uid(),
    'handover_to_label', CASE WHEN i.payer_handover_to IS NULL THEN NULL ELSE split_part((SELECT email FROM users WHERE id = i.payer_handover_to), '@', 1) END
  ) ORDER BY i.team_name), '[]'::jsonb)
  FROM slack_installs i
  WHERE auth.uid() IS NOT NULL
    AND (public.slack_installer_user(i.team_id) = auth.uid() OR EXISTS (SELECT 1 FROM slack_links l WHERE l.team_id = i.team_id AND l.user_id = auth.uid()));
$$;

/** Linked members of a workspace, for the hand-over picker (payer or installer only). */
CREATE OR REPLACE FUNCTION public.get_slack_members(p_team_id text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN jsonb_build_object('ok', false, 'error', 'not_authenticated')
    WHEN NOT EXISTS (SELECT 1 FROM slack_installs i WHERE i.team_id = p_team_id AND (i.payer_user_id = auth.uid() OR public.slack_installer_user(i.team_id) = auth.uid()))
      THEN jsonb_build_object('ok', false, 'error', 'not_the_payer')
    ELSE jsonb_build_object('ok', true, 'members', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('user_id', l.user_id, 'label', split_part(u.email, '@', 1)) ORDER BY u.email)
      FROM slack_links l JOIN users u ON u.id = l.user_id WHERE l.team_id = p_team_id AND l.user_id <> auth.uid()), '[]'::jsonb))
  END;
$$;
REVOKE ALL ON FUNCTION public.get_slack_members(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_slack_members(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_slack_payer_service(p_team_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  i slack_installs%ROWTYPE;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RETURN jsonb_build_object('ok', false, 'error', 'forbidden'); END IF;
  SELECT * INTO i FROM slack_installs WHERE team_id = p_team_id;
  RETURN jsonb_build_object(
    'ok', true,
    'mode', CASE WHEN i.payer_user_id IS NULL THEN 'members' ELSE COALESCE(i.payer_mode, 'members') END,
    'payer_user_id', i.payer_user_id,
    'payer_slack_user_id', (SELECT l.slack_user_id FROM slack_links l WHERE l.team_id = p_team_id AND l.user_id = i.payer_user_id LIMIT 1),
    'payer_label', CASE WHEN i.payer_user_id IS NULL THEN NULL ELSE split_part((SELECT email FROM users WHERE id = i.payer_user_id), '@', 1) END,
    'team_name', i.team_name
  );
END;
$$;
COMMIT;
