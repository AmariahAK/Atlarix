/**
 * Atlarix Authentication Configuration
 * ====================================
 */

// API Base URL (will be Fly.io in production)
export const API_BASE_URL = process.env.ATLARIX_API_URL || 'http://localhost:3001';

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
