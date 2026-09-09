import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Shared CORS for the app's authenticated edge functions.
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

export type AuthedUser = { id: string; email: string | null };

/**
 * Verifies the caller's Supabase JWT and returns the authenticated user. The
 * user id here is TRUSTED (derived from a verified token) — never take the id or
 * email from the request body for a privileged action.
 */
export async function getAuthedUser(req: Request): Promise<AuthedUser | null> {
  const authHeader =
    req.headers.get("Authorization") ?? req.headers.get("authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return null;

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) return null;

  const supabase = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
