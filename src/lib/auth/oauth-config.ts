/**
 * OAuth Configuration for Atlarix
 * ==================================
 * Auth is handled entirely by Supabase (Google/GitHub sign-in via Supabase).
 * This file only defines the deep-link redirect for the native app.
 */

// Deep-link redirect after sign-in (Supabase redirects here)
export const OAUTH_REDIRECT_URI = 'atlarix://auth/callback';
