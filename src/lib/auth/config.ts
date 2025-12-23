/**
 * Atlarix Authentication Configuration
 * ====================================
 */

// API Base URL (will be Fly.io in production)
export const API_BASE_URL = process.env.ATLARIX_API_URL || 'http://localhost:3001';

// OAuth Configuration
export const GOOGLE_OAUTH_CONFIG = {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    redirectUri: 'atlarix://auth/callback',
    scopes: ['email', 'profile'],
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
};

export const GITHUB_OAUTH_CONFIG = {
    clientId: process.env.GITHUB_CLIENT_ID || '',
    redirectUri: 'atlarix://auth/callback',
    scopes: ['user:email'],
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
};

// Free Tier Configuration
export const FREE_TIER = {
    dailyPromptLimit: 5,
    resetTimeUTC: '00:00', // Midnight UTC
};

// Device Limits
export const DEVICE_LIMITS = {
    maxDevicesPerUser: 5,
};

// Offline Mode
export const OFFLINE_CONFIG = {
    cacheDurationDays: 7, // Allow 7 days offline for paid users
};
