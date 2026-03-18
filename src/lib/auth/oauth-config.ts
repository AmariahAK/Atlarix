/**
 * OAuth Configuration for Atlarix
 * ==================================
 * OAuth flows are handled by Supabase; backend API URLs and redirect handling only.
 */

// OAuth redirect handling
export const OAUTH_REDIRECT_URI = 'atlarix://auth/callback';

// OAuth URLs (for reference; Supabase manages the actual flows)
export const OAUTH_URLS = {
    google: {
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
    },
    github: {
        authUrl: 'https://github.com/login/oauth/authorize',
        tokenUrl: 'https://github.com/login/oauth/access_token',
        userInfoUrl: 'https://api.github.com/user',
    },
};

// Backend API endpoint for OAuth
export const BACKEND_API_URL = import.meta.env.VITE_ATLARIX_API_URL || 'https://atlarix-api.fly.dev';

export const AUTH_ENDPOINTS = {
    google: `${BACKEND_API_URL}/api/auth/google`,
    github: `${BACKEND_API_URL}/api/auth/github`,
    status: `${BACKEND_API_URL}/api/user/status`,
    registerDevice: `${BACKEND_API_URL}/api/device/register`,
};
