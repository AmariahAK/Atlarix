/**
 * Atlarix Authentication Types
 * ============================
 */

export type OAuthProvider = 'google' | 'github';

export type PlanType = 'free' | 'monthly' | 'annual_sub' | 'annual_license';

export type SubscriptionStatus = 'active' | 'expired' | 'cancelled';

export interface User {
    id: string;
    email: string;
    name: string;
    avatar: string;
    oauth_provider: OAuthProvider;
    createdAt: Date;
    lastSignIn: Date;
}

export interface Subscription {
    plan: PlanType;
    status: SubscriptionStatus;
    versions: string[]; // ['v1', 'v2', etc.]
    currentPeriodEnd?: Date;
    lemonSqueezyId?: string;
}

export interface UserStatus {
    user: User;
    subscription: Subscription;
    promptsRemaining: number | null; // null for paid users
    promptsResetAt: Date | null;
    devices: number;
    maxDevices: number;
}

export interface AuthToken {
    token: string;
    expiresAt: Date;
}

export interface Device {
    id: string;
    deviceId: string;
    deviceName: string;
    os: 'macOS' | 'Windows' | 'Linux';
    lastActive: Date;
    createdAt: Date;
}
