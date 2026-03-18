/**
 * Atlarix Authentication Configuration
 * ====================================
 * Self-contained native app; DB and auth via Supabase. No separate API URL.
 */

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
