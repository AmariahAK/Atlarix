-- v4.0: Teams and team_members tables; users.team_id and users.effective_tier
-- Additive only. Run when users table already exists.

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

-- 2. Add team_id to users (references teams)
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

-- 4. Extend plan to allow 'workforce' (drop existing check if any)
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

-- 5. Add effective_tier on users
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
