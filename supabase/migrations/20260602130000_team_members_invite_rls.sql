-- Team invite RLS policies (production parity).
-- Allows invitees to see/update pending rows for their email before accept.

DROP POLICY IF EXISTS "team_members_pending_select" ON public.team_members;
CREATE POLICY "team_members_pending_select"
  ON public.team_members
  FOR SELECT
  USING (
    status = 'pending'
    AND email = (
      SELECT users.email
      FROM public.users
      WHERE users.id = auth.uid()
      LIMIT 1
    )
  );

DROP POLICY IF EXISTS "team_members_self_update" ON public.team_members;
CREATE POLICY "team_members_self_update"
  ON public.team_members
  FOR UPDATE
  USING (
    user_id = auth.uid()
    OR (
      status = 'pending'
      AND email = (
        SELECT users.email
        FROM public.users
        WHERE users.id = auth.uid()
        LIMIT 1
      )
    )
  )
  WITH CHECK (
    user_id = auth.uid()
    OR (
      status = 'pending'
      AND email = (
        SELECT users.email
        FROM public.users
        WHERE users.id = auth.uid()
        LIMIT 1
      )
    )
  );
