-- v4.0: RLS for teams and team_members so authenticated users can manage their team
ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

-- Teams: owner can do everything; members can read
CREATE POLICY "teams_owner_all"
    ON public.teams FOR ALL
    USING (auth.uid() = owner_user_id)
    WITH CHECK (auth.uid() = owner_user_id);

CREATE POLICY "teams_member_read"
    ON public.teams FOR SELECT
    USING (
        id IN (
            SELECT team_id FROM public.team_members
            WHERE user_id = auth.uid() AND status = 'active'
        )
    );

-- Team members: team owner can manage; members can read
CREATE POLICY "team_members_owner_all"
    ON public.team_members FOR ALL
    USING (
        team_id IN (SELECT id FROM public.teams WHERE owner_user_id = auth.uid())
    )
    WITH CHECK (
        team_id IN (SELECT id FROM public.teams WHERE owner_user_id = auth.uid())
    );

CREATE POLICY "team_members_member_read"
    ON public.team_members FOR SELECT
    USING (
        team_id IN (
            SELECT team_id FROM public.team_members t2
            WHERE t2.user_id = auth.uid() AND t2.status = 'active'
        )
    );

-- Service role still has full access (handled by default service_role bypass)
