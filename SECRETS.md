# Atlarix Secrets & Environment Variables

**Never commit `.env` or real secrets.** Use this file as a reference for local development and CI (GitHub Actions) secrets.

## Required for full functionality

- **Supabase:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` — from Supabase Dashboard → Settings → API.
- **LemonSqueezy (Pro checkout):** `LEMONSQUEEZY_API_KEY` — from [LemonSqueezy API](https://app.lemonsqueezy.com/settings/api). Optional: `LEMONSQUEEZY_STORE_ID`, `LEMONSQUEEZY_VARIANT_ID`.

## v4.0 Workforce

- **LemonSqueezy Workforce:** Create products in LemonSqueezy dashboard (Workforce monthly, Extra Seat monthly add-on). See [LEMONSQUEEZY_SETUP.md](docs/LEMONSQUEEZY_SETUP.md) for step-by-step. Then set:
  - `LEMONSQUEEZY_WORKFORCE_VARIANT_ID`
  - `LEMONSQUEEZY_EXTRA_SEAT_VARIANT_ID`
- **Auth0 Token Vault:** For Workforce extensions (Slack, Jira, etc.). From [Auth0 for AI Agents](https://auth0.com/ai/docs/intro/token-vault):
  - `AUTH0_DOMAIN`
  - `AUTH0_CLIENT_ID`
  - `AUTH0_CLIENT_SECRET`
  - `AUTH0_TOKEN_VAULT_ID`
  - `AUTH0_AUDIENCE`
  If unset, the app falls back to existing credential store and shows a warning toast.

## OAuth (Supabase Auth)

- **Google / GitHub:** Client IDs in `.env`; client secrets are set in Supabase Dashboard → Auth → Providers (not in repo).

## Optional

- **Sentry:** `SENTRY_DSN` — error monitoring.
- **PostHog:** `POSTHOG_API_KEY` — product analytics (user opt-in).
- **Backend API:** `ATLARIX_API_URL`, `VITE_ATLARIX_API_URL`.

## CI (GitHub Actions)

Add the same variables as repository secrets (Settings → Secrets and variables → Actions). See [README](README.md) deployment section for the full list.
