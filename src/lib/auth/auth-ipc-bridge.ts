/**
 * Single IPC subscription for auth events (avoids MaxListenersExceeded when many useAuth() mounts).
 */

import type { AuthUser } from "./useAuth";

type OAuthPayload = { user: AuthUser };
type PlanChangedPayload = {
  plan: "free" | "pro";
  effectiveTier?: "free" | "pro";
  previousPlan?: "free" | "pro";
  subscriptionStatus?: string | null;
  subscriptionEndsAt?: string | null;
};

const oauthListeners = new Set<(data: OAuthPayload) => void>();
const planListeners = new Set<(data: PlanChangedPayload) => void>();

let registered = false;
let lastPlanFanOutKey = "";
let lastPlanFanOutAt = 0;
const PLAN_FANOUT_DEDUPE_MS = 500;

function planFanOutKey(data: PlanChangedPayload): string {
  const tier = data.effectiveTier ?? data.plan;
  return `${tier}|${data.subscriptionStatus ?? ""}|${data.subscriptionEndsAt ?? ""}`;
}

function shouldFanOutPlanChange(data: PlanChangedPayload): boolean {
  const key = planFanOutKey(data);
  const now = Date.now();
  if (key === lastPlanFanOutKey && now - lastPlanFanOutAt < PLAN_FANOUT_DEDUPE_MS) {
    return false;
  }
  lastPlanFanOutKey = key;
  lastPlanFanOutAt = now;
  return true;
}

function ensureRegistered(): void {
  if (registered) return;
  const ipcRenderer = window.electron?.ipcRenderer;
  if (!ipcRenderer?.on) return;
  registered = true;

  ipcRenderer.on("oauth-callback-success", ((...args: unknown[]) => {
    const data = (args.length > 1 ? args[1] : args[0]) as OAuthPayload;
    for (const fn of oauthListeners) fn(data);
  }) as (...args: unknown[]) => void);

  ipcRenderer.on("plan-changed", ((...args: unknown[]) => {
    const data = (args.length > 1 ? args[1] : args[0]) as PlanChangedPayload;
    if (!shouldFanOutPlanChange(data)) return;
    for (const fn of planListeners) fn(data);
  }) as (...args: unknown[]) => void);
}

export function subscribeOAuthSuccess(fn: (data: OAuthPayload) => void): () => void {
  ensureRegistered();
  oauthListeners.add(fn);
  return () => oauthListeners.delete(fn);
}

export function subscribePlanChanged(fn: (data: PlanChangedPayload) => void): () => void {
  ensureRegistered();
  planListeners.add(fn);
  return () => planListeners.delete(fn);
}
