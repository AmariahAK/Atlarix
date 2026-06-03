-- v4.0: Workforce connected services (MCP / extension connections per user)
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
COMMENT ON TABLE public.workforce_connected_services IS 'v4.0 Workforce extension / MCP connection metadata per user';

ALTER TABLE public.workforce_connected_services ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "workforce_connected_services_select_own" ON public.workforce_connected_services;
CREATE POLICY "workforce_connected_services_select_own"
  ON public.workforce_connected_services
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "workforce_connected_services_insert_own" ON public.workforce_connected_services;
CREATE POLICY "workforce_connected_services_insert_own"
  ON public.workforce_connected_services
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "workforce_connected_services_update_own" ON public.workforce_connected_services;
CREATE POLICY "workforce_connected_services_update_own"
  ON public.workforce_connected_services
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "workforce_connected_services_delete_own" ON public.workforce_connected_services;
CREATE POLICY "workforce_connected_services_delete_own"
  ON public.workforce_connected_services
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);
