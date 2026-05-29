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

# GitHub OAuth (device flow — repo clone)
OAUTH_CLIENT_ID=your_github_oauth_app_client_id
# Legacy fallback until renamed:
# GITHUB_CLIENT_ID=your_github_oauth_app_client_id

# GitHub OAuth (Supabase sign-in — optional UI)
VITE_GITHUB_CLIENT_ID=your_github_client_id
GITHUB_CLIENT_SECRET=your_github_client_secret

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
6. In Atlarix `.env`, set `VITE_GITHUB_CLIENT_ID` to the same GitHub Client ID (optional, for UI). The app uses Supabase’s OAuth flow; redirect back to the app is `atlarix://auth/callback`.

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

### 4. Backend Integration

The backend API at `atlarix-api.fly.dev` handles:
- Token exchange (authorization code → access token)
- User creation/lookup
- Subscription status
- Device management

## Usage

```tsx
import { useAuth } from '@/lib/auth/useAuth';

function MyComponent() {
  const { user, status, signInWithGoogle, signInWithGitHub, signOut } = useAuth();

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
      <p>Prompts remaining: {status?.prompts_remaining || 'Unlimited'}</p>
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
