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

/**
 * The startup session restore SETTLED. Carries the answer — `user: null` means
 * genuinely signed out, which is information, not an absence of it.
 *
 * Deliberately carries the state rather than acting as a bare "go re-check"
 * ping: with ~22 `useAuth()` mounts, a ping would become 22 IPC round-trips on
 * every launch.
 */
export type AuthResolvedPayload = {
  user: {
    id: string;
    email: string;
    name?: string;
    avatar?: string;
    plan?: "free" | "pro";
    effectiveTier?: "free" | "pro";
  } | null;
  plan?: "free" | "pro";
};

const oauthListeners = new Set<(data: OAuthPayload) => void>();
const planListeners = new Set<(data: PlanChangedPayload) => void>();
const authResolvedListeners = new Set<(data: AuthResolvedPayload) => void>();

let registered = false;
/** Retained so a `useAuth()` mounting AFTER the event still learns the answer. */
let lastAuthResolved: AuthResolvedPayload | null = null;
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

  ipcRenderer.on("auth:resolved", ((...args: unknown[]) => {
    const data = (args.length > 1 ? args[1] : args[0]) as AuthResolvedPayload;
    lastAuthResolved = data ?? { user: null };
    for (const fn of authResolvedListeners) fn(lastAuthResolved);
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

/**
 * Subscribe to the startup-restore-settled event.
 *
 * Replays the last payload to a late subscriber. The event fires once, early,
 * and a `useAuth()` that mounts after it — a lazily rendered route, a panel
 * opened later — would otherwise never learn the restore had settled and would
 * show its own launch placeholder indefinitely.
 */
export function subscribeAuthResolved(
  fn: (data: AuthResolvedPayload) => void,
): () => void {
  ensureRegistered();
  authResolvedListeners.add(fn);
  if (lastAuthResolved) fn(lastAuthResolved);
  return () => authResolvedListeners.delete(fn);
}
