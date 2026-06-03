-- Add subscription columns to existing users table
-- This adds LemonSqueezy integration to track user plans

-- Add plan column if it doesn't exist
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_schema = 'public' 
                   AND table_name = 'users' 
                   AND column_name = 'plan') THEN
        ALTER TABLE public.users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro'));
    END IF;
END $$;

-- Add subscription_status column if it doesn't exist
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_schema = 'public' 
                   AND table_name = 'users' 
                   AND column_name = 'subscription_status') THEN
        ALTER TABLE public.users ADD COLUMN subscription_status TEXT;
    END IF;
END $$;

-- Add subscription_ends_at if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public'
                   AND table_name = 'users'
                   AND column_name = 'subscription_ends_at') THEN
        ALTER TABLE public.users ADD COLUMN subscription_ends_at TIMESTAMPTZ;
    END IF;
END $$;

-- Add lemon_customer_id column if it doesn't exist
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_schema = 'public' 
                   AND table_name = 'users' 
                   AND column_name = 'lemon_customer_id') THEN
        ALTER TABLE public.users ADD COLUMN lemon_customer_id TEXT;
    END IF;
END $$;

-- Add lemon_subscription_id column if it doesn't exist
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_schema = 'public' 
                   AND table_name = 'users' 
                   AND column_name = 'lemon_subscription_id') THEN
        ALTER TABLE public.users ADD COLUMN lemon_subscription_id TEXT;
    END IF;
END $$;

-- Add lemon_variant_id column if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public'
                   AND table_name = 'users'
                   AND column_name = 'lemon_variant_id') THEN
        ALTER TABLE public.users ADD COLUMN lemon_variant_id TEXT;
    END IF;
END $$;

-- Add customer_portal_url column if it doesn't exist (for manage subscription)
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_schema = 'public' 
                   AND table_name = 'users' 
                   AND column_name = 'customer_portal_url') THEN
        ALTER TABLE public.users ADD COLUMN customer_portal_url TEXT;
    END IF;
END $$;

-- Onboarding flag (guided first-run flow)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public'
                   AND table_name = 'users'
                   AND column_name = 'onboarding_completed') THEN
        ALTER TABLE public.users ADD COLUMN onboarding_completed BOOLEAN NOT NULL DEFAULT false;
    END IF;
END $$;

-- Create index for lemon_subscription_id (for webhook lookups)
CREATE INDEX IF NOT EXISTS idx_users_lemon_subscription_id ON public.users(lemon_subscription_id);

-- Legacy service-role policy (superseded by 20260118152000_strict_rls.sql on fresh installs)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE tablename = 'users' 
        AND policyname = 'Service role has full access'
    ) THEN
        CREATE POLICY "Service role has full access"
            ON public.users
            FOR ALL
            USING (auth.role() = 'service_role');
    END IF;
END $$;

COMMENT ON COLUMN public.users.plan IS 'User subscription plan: free, pro, or workforce';
COMMENT ON COLUMN public.users.lemon_subscription_id IS 'LemonSqueezy subscription ID for webhooks';
