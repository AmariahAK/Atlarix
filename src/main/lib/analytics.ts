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
 * Capture an event only if user has opted in. No-op otherwise.
 * Use for main-process events: app_launched, workspace_opened, diagram_generated, etc.
 */
export function capture(
  event: string,
  properties?: Record<string, unknown>,
): void {
  if (!isOptedIn()) return;
  const posthog = getPostHog();
  if (!posthog) return;
  const distinctId = getOrCreateAnonymousId();
  posthog.capture({ distinctId, event, properties });
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

/** A user wired up a usable model (Core sign-in or a BYOK provider key). */
export function trackModelConnected(properties?: Record<string, unknown>): void {
  captureSafe("model_connected", properties);
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
