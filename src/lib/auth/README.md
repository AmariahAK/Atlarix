# OAuth Authentication Setup

This directory contains the OAuth authentication infrastructure for Atlarix.

## Files

### `oauth-config.ts`

Configuration for Google and GitHub OAuth providers:

- Client IDs and redirect URIs
- OAuth scopes
- Backend API endpoints
- Token exchange URLs

### `useAuth.ts`

React hook for authentication:

- Sign in with Google/GitHub
- Token management
- User status fetching
- Device registration

## Environment Variables

Add these to your `.env` file:

```bash
# Google OAuth
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret

# GitHub OAuth (Supabase sign-in — configure Client ID/secret in Supabase Dashboard, not here)

# Backend API
ATLARIX_API_URL=https:// atlarix-api.fly.dev
```

## Setup Instructions

### 1. Google OAuth

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Enable Google+ API
4. Go to "Credentials" → "Create Credentials" → "OAuth 2.0 Client ID"
5. Application type: Desktop app
6. Add authorized redirect URI: `atlarix://auth/callback`
7. Copy Client ID and Client Secret to `.env`

### 2. GitHub OAuth (via Supabase)

1. In **Supabase Dashboard**: Authentication → Providers → **GitHub** → Enable.
2. Supabase shows the **Authorization callback URL** (e.g. `https://<project-ref>.supabase.co/auth/v1/callback`). Copy it.
3. Go to [GitHub Developer Settings → OAuth Apps](https://github.com/settings/developers) → **New OAuth App**.
4. Application name: Atlarix. Homepage URL: `https://atlarix.dev`. **Authorization callback URL**: paste the Supabase callback URL from step 2.
5. Copy **Client ID** and **Client Secret** from GitHub into Supabase (Authentication → Providers → GitHub). Save.
   > **There is no second GitHub credential.** A device-flow `OAUTH_CLIENT_ID` used to live here for
   > the in-app repo clone; that feature was removed in v14.41.0 (cloning is `git clone` through
   > `run_command`, with the user's own auth), and the variable with it. Steps 1-5 are the whole
   > GitHub setup: Supabase holds the Client ID and Secret server-side, and Atlarix never reads them.
   > Two GitHub credentials for unrelated reasons is what made users think this one was their sign-in.

### 3. Protocol Handler

The `atlarix://` protocol is registered in `forge.config.ts`:

```typescript
protocols: [
  {
    name: "Atlarix",
    schemes: ["atlarix"],
  },
],
```

### 4. Supabase Redirect URLs — the setting that breaks sign-in silently

Supabase Dashboard → **Authentication → URL Configuration → Redirect URLs** must contain,
byte for byte:

```
atlarix://auth/callback
```

**Why byte for byte.** GoTrue compiles each entry into a glob (separators `.` and `/`) and
matches the requested `redirect_to` as a literal string. There is no URL normalisation, so
`atlarix:///auth/callback` (three slashes) does **not** match `atlarix://auth/callback`.

**And a non-match is not an error.** GoTrue substitutes the **Site URL** instead. The
symptom is that sign-in opens the browser, the user completes it, the browser lands on
`https://www.atlarix.dev`, and the desktop app is never launched — with nothing logged
anywhere that names a redirect. If sign-in "does nothing", check this list first.

Releases up to and including **v14.38.3 send the three-slash spelling**
(`atlarix:///auth/callback` — `AUTH_CALLBACK_URL` was built by concatenating
`AUTH_CALLBACK_PATH`, which already carries a leading slash). Those builds stay broken
until they update, so the allowlist needs a second entry covering them:

```
atlarix://auth/callback        <- what the app sends from v14.38.4 on
atlarix://*/auth/callback      <- covers v14.38.3 and earlier
```

**The three-slash string cannot be entered literally** — the dashboard's validator rejects
a URL with an empty host ("Please provide a valid URL"). `atlarix://*/auth/callback` is the
way in: GoTrue's `*` matches a sequence of non-separator characters _including the empty
one_, so it matches the empty host, while `/` remains a separator it will not cross.

Verified 2026-08-29 against `gobwas/glob` compiled the way GoTrue compiles it
(`glob.Compile(uri, '.', '/')`):

| pattern                     | `atlarix:///auth/callback` | `atlarix://auth/callback` | `atlarix://mcp/oauth/callback` |
| --------------------------- | -------------------------- | ------------------------- | ------------------------------ |
| `atlarix://auth/callback`   | no                         | **match**                 | no                             |
| `atlarix://*/auth/callback` | **match**                  | no                        | no                             |
| `atlarix://**`              | match                      | match                     | match                          |

Neither pattern covers the other, so **keep both**. And do not reach for `atlarix://**`:
it also makes `atlarix://mcp/oauth/callback` a legal OAuth redirect target, which is the
MCP handler's deep link, not an auth one.

`supabase/config.toml` does **not** hold this list. Its `[auth]` block is the _local dev_
stack's config (`site_url = "http://127.0.0.1:3000"`), so `supabase config push` would
overwrite the hosted Site URL with localhost. Edit the hosted list in the dashboard.

### 5. Backend Integration

The backend API at `atlarix-api.fly.dev` handles:

- Token exchange (authorization code → access token)
- User creation/lookup
- Subscription status
- Device management

## Usage

```tsx
import { useAuth } from "@/lib/auth/useAuth";

function MyComponent() {
  const { user, status, signInWithGoogle, signInWithGitHub, signOut } =
    useAuth();

  if (!user) {
    return (
      <div>
        <button onClick={signInWithGoogle}>Sign in with Google</button>
        <button onClick={signInWithGitHub}>Sign in with GitHub</button>
      </div>
    );
  }

  return (
    <div>
      <p>Welcome, {user.name}!</p>
      <p>Plan: {status?.plan}</p>
      <p>Prompts remaining: {status?.prompts_remaining || "Unlimited"}</p>
      <button onClick={signOut}>Sign Out</button>
    </div>
  );
}
```

## Security Notes

- Client secrets should NEVER be exposed in the frontend
- Token exchange happens server-side via backend API
- Tokens are stored in localStorage (consider using secure storage for production)
- Device IDs are generated and persisted per installation

---

© 2024-2025 NorahLabs. All Rights Reserved.
