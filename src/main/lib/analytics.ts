/**
 * Main-process PostHog analytics. Only sends events when user has opted in (telemetryConsent === 'opted_in').
 * Uses a persistent anonymous ID stored in userData/analytics-id.json (no email, name, or identifiable data).
 */

import path from "node:path";
import fs from "node:fs";
import { app } from "electron";
import { PostHog } from "posthog-node";
import { readSettings } from "../settings";
import { v4 as uuidv4 } from "uuid";
import { buildConfig } from "@/generated/build-config";

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
  const apiKey = buildConfig.POSTHOG_API_KEY;
  if (!apiKey) return null;
  client = new PostHog(apiKey, { host: POSTHOG_HOST });
  return client;
}

/**
 * Capture an event only if user has opted in. No-op otherwise.
 * Use for main-process events: app_launched, workspace_opened, blueprint_generated, etc.
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
    posthogApiKey: buildConfig.POSTHOG_API_KEY || undefined,
    analyticsId: getOrCreateAnonymousId(),
  };
}
