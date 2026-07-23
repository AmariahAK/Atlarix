/**
 * Main-process PostHog analytics. Only sends events when user has opted in (telemetryConsent === 'opted_in').
 * Uses a persistent anonymous ID stored in userData/analytics-id.json (no email, name, or identifiable data).
 */

import path from "node:path";
import fs from "node:fs";
import { app } from "electron";
import { PostHog } from "posthog-node";
import { readSettings, writeSettings } from "../settings";
import { v4 as uuidv4 } from "uuid";

const ANALYTICS_ID_FILE = "analytics-id.json";
const POSTHOG_HOST = "https://eu.i.posthog.com";

let client: PostHog | null = null;

function getAnalyticsIdPath(): string {
  return path.join(app.getPath("userData"), ANALYTICS_ID_FILE);
}

/** Persistent anonymous ID for analytics (no PII). Exported for IPC so renderer can identify. */
export function getOrCreateAnonymousId(): string {
  const filePath = getAnalyticsIdPath();
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw) as { id?: string };
      if (data.id && typeof data.id === "string") {
        return data.id;
      }
    }
  } catch {
    // ignore
  }
  const id = uuidv4();
  try {
    fs.writeFileSync(filePath, JSON.stringify({ id }, null, 2), "utf-8");
  } catch {
    // non-fatal
  }
  return id;
}

function isOptedIn(): boolean {
  const settings = readSettings();
  return settings.telemetryConsent === "opted_in";
}

/**
 * Get the PostHog client singleton. Returns null if POSTHOG_API_KEY is not set or user has not opted in.
 */
export function getPostHog(): PostHog | null {
  if (client) return client;
  const apiKey = process.env.POSTHOG_API_KEY;
  if (!apiKey) return null;
  client = new PostHog(apiKey, { host: POSTHOG_HOST });
  return client;
}

/**
 * The signed-in Supabase user id, once known. Set by `identifyUser` at sign-in
 * and cleared at sign-out; deliberately in-memory only, since the source of
 * truth is the Supabase session which is re-read on every launch anyway.
 */
let signedInUserId: string | null = null;

/**
 * The id every event is attributed to: the Supabase user when signed in, else
 * the per-install anonymous id.
 *
 * Why this matters: the anonymous id lives in this machine's userData, so
 * before the alias existed, the SAME human on two machines was two people and a
 * reinstall minted a third. Every per-user number — retention above all — was
 * inflated in a way no dashboard filter could repair.
 */
function resolveDistinctId(): string {
  return signedInUserId ?? getOrCreateAnonymousId();
}

/**
 * Link this install's anonymous history to the signed-in user, then attribute
 * everything after to the user id.
 *
 * `alias` is sent at most ONCE per install per user (marker persisted in
 * settings): PostHog merges the two identities permanently, so re-sending is
 * pure noise and repeated aliasing can muddy the identity graph.
 *
 * `distinctId` stays the Supabase UUID even though person properties now carry
 * the email. This is deliberate and the PostHog-recommended shape: an email is
 * MUTABLE, so using it as the identity key means a user who changes their
 * address becomes a brand-new person and orphans all their history — exactly
 * the split this whole change exists to remove. The UUID is the key; the email
 * is a label PostHog displays and lets you search/filter on, which gives you
 * the "tell people apart at a glance" benefit with none of the fragility.
 *
 * Email/name ARE sent (owner decision) so accounts are identifiable in the
 * PostHog UI. Still never sent: code, prompts, file names, file contents.
 */
export function identifyUser(
  userId: string,
  properties?: Record<string, unknown>,
): void {
  if (!userId) return;
  signedInUserId = userId;
  if (!isOptedIn()) return;
  const posthog = getPostHog();
  if (!posthog) return;
  try {
    const anonymousId = getOrCreateAnonymousId();
    const settings = readSettings();
    const aliased = settings.analyticsAliasedUserIds ?? [];
    if (anonymousId !== userId && !aliased.includes(userId)) {
      posthog.alias({ distinctId: userId, alias: anonymousId });
      writeSettings({ analyticsAliasedUserIds: [...aliased, userId] });
    }
    posthog.identify({ distinctId: userId, properties });
  } catch {
    /* analytics must never break sign-in */
  }
}

/** Sign-out: fall back to the anonymous id rather than keep attributing to a user. */
export function clearIdentifiedUser(): void {
  signedInUserId = null;
}

/**
 * Capture an event only if user has opted in. No-op otherwise.
 * Use for main-process events: app_opened, workspace_opened, task_completed, etc.
 */
export function capture(
  event: string,
  properties?: Record<string, unknown>,
): void {
  if (!isOptedIn()) return;
  const posthog = getPostHog();
  if (!posthog) return;
  posthog.capture({ distinctId: resolveDistinctId(), event, properties });
}

/** Fire-and-forget capture; never throws (analytics must not break the app). */
export function captureSafe(
  event: string,
  properties?: Record<string, unknown>,
): void {
  try {
    capture(event, properties);
  } catch {
    /* noop */
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Activation funnel: app_opened → model_connected → first_task_started →
// first_task_completed → task_completed (repeat). Each helper is fire-and-forget
// and never throws. The first_* events fire exactly once via persisted markers;
// nothing is recorded (and no marker is advanced) unless the user opted in, so
// the funnel starts cleanly if consent is granted later.
// ────────────────────────────────────────────────────────────────────────────

/** A user wired up a usable model (Core sign-in, a BYOK key, or a local runtime). */
export function trackModelConnected(
  properties?: Record<string, unknown>,
): void {
  captureSafe("model_connected", properties);
}

/**
 * Local runtimes (Ollama, LM Studio) need no API key, so they never pass through
 * the provider-key handler that fires `model_connected` — a local-only user
 * looked like they had connected no model at all and silently fell out of the
 * activation funnel. Fires once per provider per install.
 */
export function trackLocalModelConnected(providerId: string): void {
  try {
    if (!isOptedIn()) return;
    const settings = readSettings();
    const seen = settings.analyticsLocalProvidersSeen ?? [];
    if (seen.includes(providerId)) return;
    writeSettings({ analyticsLocalProvidersSeen: [...seen, providerId] });
    captureSafe("model_connected", { type: "local", provider: providerId });
  } catch {
    /* analytics must never break model resolution */
  }
}

/** Local calendar date, `YYYY-MM-DD`. Local, not UTC: "did they come back the
 * next day" is a question about the user's day, not about a timezone. */
function localDayKey(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * One `active_day` per calendar day per install.
 *
 * Retention was previously only inferable from whatever other events happened to
 * be instrumented, which meant the curve moved when instrumentation changed
 * rather than when behaviour did. A single deliberate daily signal makes
 * day-N retention a direct question.
 */
export function trackActiveDay(): void {
  try {
    if (!isOptedIn()) return;
    const today = localDayKey();
    const settings = readSettings();
    if (settings.lastActiveDay === today) return;
    writeSettings({ lastActiveDay: today });
    captureSafe("active_day", { date: today });
  } catch {
    /* analytics must never break startup */
  }
}

/** The first real agent turn in a workspace started (fires once). */
export function trackTaskStarted(properties?: Record<string, unknown>): void {
  try {
    if (!isOptedIn()) return;
    if (readSettings().firstTaskStartedAt) return;
    writeSettings({ firstTaskStartedAt: Date.now() });
    captureSafe("first_task_started", properties);
  } catch {
    /* analytics must never break the turn */
  }
}

/**
 * An agent turn finished successfully. The first success fires
 * `first_task_completed`; every success after that fires `task_completed`.
 */
export function trackTaskCompleted(properties?: Record<string, unknown>): void {
  try {
    if (!isOptedIn()) return;
    if (!readSettings().firstTaskCompletedAt) {
      writeSettings({ firstTaskCompletedAt: Date.now() });
      captureSafe("first_task_completed", properties);
    } else {
      captureSafe("task_completed", properties);
    }
  } catch {
    /* analytics must never break the turn */
  }
}

/**
 * Flush and shutdown the client. Call before app quit.
 */
export function shutdown(): void {
  if (client) {
    client.flush();
    client = null;
  }
}

/** Config for renderer PostHog init (API key + anonymous ID). Key is undefined if not set. */
export function getPostHogConfigForRenderer(): {
  posthogApiKey: string | undefined;
  analyticsId: string;
} {
  return {
    posthogApiKey: process.env.POSTHOG_API_KEY || undefined,
    analyticsId: getOrCreateAnonymousId(),
  };
}
