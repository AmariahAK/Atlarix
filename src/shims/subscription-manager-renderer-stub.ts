/**
 * Renderer stub — subscription/auth gating runs in the main process (IPC).
 */

export type UserPlan = "free" | "pro";

export interface UserSession {
  id: string;
  email: string;
  name?: string;
  avatar?: string;
  plan: UserPlan;
  effectiveTier?: UserPlan;
}

export class SubscriptionManager {
  static async initialize(): Promise<void> {}

  static getCurrentUser(): UserSession | null {
    return null;
  }

  static isLoggedIn(): boolean {
    return false;
  }

  static getLocalUserPlan(): UserPlan {
    return "free";
  }

  static isPro(): boolean {
    return false;
  }

  static getEffectiveTier(): UserPlan {
    return "free";
  }

  static async refreshPlan(): Promise<UserPlan> {
    return "free";
  }

  static async signIn(
    _provider: "google" | "github",
  ): Promise<{ error: Error | null }> {
    return { error: new Error("SubscriptionManager is only available in the main process") };
  }

  static async signOut(): Promise<void> {}

  static async handleOAuthCallback(_url: string): Promise<{
    success: boolean;
    user: UserSession | null;
    error: Error | null;
  }> {
    return {
      success: false,
      user: null,
      error: new Error("SubscriptionManager is only available in the main process"),
    };
  }

  static async canCreateWorkspace(): Promise<{
    allowed: boolean;
    reason?: string;
    currentCount: number;
    maxAllowed: number;
  }> {
    return { allowed: true, currentCount: 0, maxAllowed: 1 };
  }

  static async getWorkspaceCount(): Promise<number> {
    return 0;
  }

  static clearWorkspaceCache(): void {}

  static async getCurrentWorkspaceDetails(): Promise<{
    id: number;
    name: string;
  } | null> {
    return null;
  }

  static canStartIncognitoChat(): boolean {
    return true;
  }

  static getIncognitoTools(): string[] {
    return ["web_search", "read_url"];
  }
}

export default SubscriptionManager;
