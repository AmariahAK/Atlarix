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

# GitHub OAuth
GITHUB_CLIENT_ID=your_github_client_id
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

### 2. GitHub OAuth

1. Go to [GitHub Developer Settings](https://github.com/settings/developers)
2. Click "New OAuth App"
3. Application name: Atlarix
4. Homepage URL: https://atlarix.dev
5. Authorization callback URL: `atlarix://auth/callback`
6. Copy Client ID and Client Secret to `.env`

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
