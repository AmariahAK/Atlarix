# Supabase v4.0 setup — Workforce tier and Teams

Run the following SQL in **Supabase Dashboard → SQL Editor** in order. This creates the teams system, adds the `workforce` tier and `effective_tier` to users, and the workforce_connected_services table. Ensure your `public.users` table already exists (from your existing auth/setup).

---

## 1. Run this SQL in Supabase SQL Editor

Copy and run the entire block below. Run **one block at a time** if your SQL Editor prefers it (blocks are separated by comments).

```sql
-- =============================================================================
-- v4.0: Teams and team_members tables; users.team_id and users.effective_tier
-- =============================================================================

-- 1. Create teams table
CREATE TABLE IF NOT EXISTS public.teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    owner_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    lemonsqueezy_subscription_id TEXT,
    seat_limit INTEGER NOT NULL DEFAULT 20,
    extra_seats INTEGER NOT NULL DEFAULT 0,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_teams_owner_user_id ON public.teams(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_teams_lemonsqueezy_subscription_id ON public.teams(lemonsqueezy_subscription_id);

-- 2. Add team_id to users
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'team_id') THEN
        ALTER TABLE public.users ADD COLUMN team_id UUID REFERENCES public.teams(id);
    END IF;
END $$;

-- 3. Create team_members
CREATE TABLE IF NOT EXISTS public.team_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'removed')),
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
    invited_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    joined_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_members_team_id ON public.team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_team_members_user_id ON public.team_members(user_id);
CREATE INDEX IF NOT EXISTS idx_team_members_email ON public.team_members(email);

-- 4. Allow 'workforce' in users.plan
DO $$
BEGIN
    ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_plan_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
DO $$
BEGIN
    ALTER TABLE public.users ADD CONSTRAINT users_plan_check
        CHECK (plan IN ('free', 'pro', 'workforce'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 5. Add effective_tier to users
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'effective_tier') THEN
        ALTER TABLE public.users ADD COLUMN effective_tier TEXT NOT NULL DEFAULT 'free'
            CHECK (effective_tier IN ('free', 'pro', 'workforce'));
    END IF;
END $$;

-- 6. Grandfather Pro users for DB Studio
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'has_db_studio_legacy') THEN
        ALTER TABLE public.users ADD COLUMN has_db_studio_legacy BOOLEAN NOT NULL DEFAULT false;
    END IF;
END $$;

COMMENT ON TABLE public.teams IS 'v4.0 Workforce teams; owner has LemonSqueezy subscription';
COMMENT ON TABLE public.team_members IS 'v4.0 Team members; status pending/active/removed';
COMMENT ON COLUMN public.users.effective_tier IS 'Highest of own plan or team plan (free|pro|workforce)';
COMMENT ON COLUMN public.users.has_db_studio_legacy IS 'True if Pro user grandfathered for DB Studio after move to Workforce';
```

```sql
-- =============================================================================
-- v4.0: RLS for teams and team_members
-- =============================================================================

ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "teams_owner_all" ON public.teams;
CREATE POLICY "teams_owner_all"
    ON public.teams FOR ALL
    USING (auth.uid() = owner_user_id)
    WITH CHECK (auth.uid() = owner_user_id);

DROP POLICY IF EXISTS "teams_member_read" ON public.teams;
CREATE POLICY "teams_member_read"
    ON public.teams FOR SELECT
    USING (
        id IN (
            SELECT team_id FROM public.team_members
            WHERE user_id = auth.uid() AND status = 'active'
        )
    );

DROP POLICY IF EXISTS "team_members_owner_all" ON public.team_members;
CREATE POLICY "team_members_owner_all"
    ON public.team_members FOR ALL
    USING (
        team_id IN (SELECT id FROM public.teams WHERE owner_user_id = auth.uid())
    )
    WITH CHECK (
        team_id IN (SELECT id FROM public.teams WHERE owner_user_id = auth.uid())
    );

DROP POLICY IF EXISTS "team_members_member_read" ON public.team_members;
CREATE POLICY "team_members_member_read"
    ON public.team_members FOR SELECT
    USING (
        team_id IN (
            SELECT team_id FROM public.team_members t2
            WHERE t2.user_id = auth.uid() AND t2.status = 'active'
        )
    );
```

```sql
-- =============================================================================
-- v4.0: Workforce connected services (Token Vault / extensions per user)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.workforce_connected_services (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    service_name TEXT NOT NULL,
    connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    scopes JSONB DEFAULT '[]'::jsonb,
    last_token_refresh TIMESTAMPTZ,
    active BOOLEAN NOT NULL DEFAULT true,
    UNIQUE(user_id, service_name)
);

CREATE INDEX IF NOT EXISTS idx_workforce_connected_services_user_id ON public.workforce_connected_services(user_id);
COMMENT ON TABLE public.workforce_connected_services IS 'v4.0 Token Vault / Workforce extension connections per user';
```

---

## 2. Giving a user the Workforce tier manually (optional)

If you need to set a user to Workforce **without** going through LemonSqueezy (e.g. for testing or a manual grant), run the following. Replace `USER_EMAIL` or `USER_ID` with the real value.

**Option A — by email:**

```sql
UPDATE public.users
SET plan = 'workforce',
    effective_tier = 'workforce'
WHERE email = 'USER_EMAIL';
```

**Option B — by user id (auth.users.id):**

```sql
UPDATE public.users
SET plan = 'workforce',
    effective_tier = 'workforce'
WHERE id = 'USER_ID';
```

**Creating a team for that user (so they are the owner):**

```sql
INSERT INTO public.teams (name, owner_user_id, seat_limit, active)
VALUES (
  'My Team',
  (SELECT id FROM auth.users WHERE email = 'USER_EMAIL' LIMIT 1),
  20,
  true
)
RETURNING id, name, owner_user_id, seat_limit;
```

Then attach the user to the team and set their `effective_tier` (if not already workforce):

```sql
UPDATE public.users
SET team_id = (SELECT id FROM public.teams WHERE owner_user_id = (SELECT id FROM auth.users WHERE email = 'USER_EMAIL' LIMIT 1) LIMIT 1),
    effective_tier = 'workforce'
WHERE id = (SELECT id FROM auth.users WHERE email = 'USER_EMAIL' LIMIT 1);
```

---

## 3. Normal flow (LemonSqueezy)

In production, Workforce tier and teams are set by the **handle-lemon-webhook** Edge Function when:

1. A customer completes checkout for the **Workforce monthly** variant.
2. Webhook receives `subscription_created` or `subscription_updated` with that variant ID.
3. The function updates `users.plan` and `users.effective_tier` to `workforce` and creates a row in `teams` with `owner_user_id` and `lemonsqueezy_subscription_id`.

Ensure `LEMONSQUEEZY_WORKFORCE_VARIANT_ID` (and optionally `LEMONSQUEEZY_EXTRA_SEAT_VARIANT_ID`) are set in the Edge Function secrets so the webhook can detect Workforce subscriptions.
