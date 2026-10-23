import posthog from "posthog-js";
// The recorder, bundled: the window's CSP (`script-src 'self'`) blocks the copy
// posthog-js would otherwise load from its CDN when recording starts (item 12).
import "posthog-js/dist/posthog-recorder";
// Not from useSettings: that imports this module, and the cycle handed a
// half-loaded copy of it to a second settings load (main CI, 15.10.1).
import { isTelemetryOptedIn } from "@/lib/analytics/telemetry-consent";
import { REPLAY_RECORDING_OPTIONS, REPLAY_SAMPLE_RATE, scrubReplayPaths } from "@/lib/analytics/replay";

/**
 * Owns WHEN the renderer's PostHog client starts.
 *
 * A leaf module on purpose. Both `renderer.tsx` (bootstrap) and `useSettings`
 * (the moment consent arrives) need to trigger initialisation, and having the
 * hook import the renderer entry point would be a circular dependency pointing
 * the wrong way.
 *
 * WHY THIS GATE EXISTS. `before_send` drops every event without consent, and
 * that was believed to be enough. It was not: `posthog.init` writes a distinct
 * id to localStorage AND a cookie, and `posthog.identify` writes again — on the
 * device of someone who answered "No thanks", and before the first-run modal has
 * even been shown. The old comment ("nothing is written for a non-consenting
 * user") was true of the SERVER and false of the DEVICE, which is the half a
 * user can actually inspect.
 *
 * Gating INITIALISATION rather than reverting `persistence` to "memory"
 * deliberately preserves the session-continuity fix that comment documents:
 * memory persistence gave every launch a fresh `$session_id`, which made session
 * count, session duration and sessions-per-user meaningless. An opted-in user
 * keeps a stable id.
 */

let client: ReturnType<typeof posthog.init> | null = null;
let pendingConfig: {
  apiKey: string;
  analyticsId: string;
  appVersion?: string;
  replaySampleRate?: number;
} | null = null;
/** This launch recorded or not (item 12): drawn once, at the first start. */
let replayDrawn: boolean | null = null;
let replayOn = false;
let random: () => number = Math.random;

/** The live client, or null while the user has not opted in. */
export function getPostHogClient(): ReturnType<typeof posthog.init> | null {
  return client;
}

/** Remember the config without starting anything. */
export function setPostHogConfig(
  apiKey: string,
  analyticsId: string,
  appVersion?: string,
  replaySampleRate?: number,
): void {
  pendingConfig = { apiKey, analyticsId, appVersion, replaySampleRate };
}

/**
 * Start the client if — and only if — the user has opted in. Safe to call
 * repeatedly; it is both the bootstrap path and the opt-in hook.
 */
export function ensurePostHogInitialized(): ReturnType<
  typeof posthog.init
> | null {
  if (client) return client;
  if (!pendingConfig) return null;
  if (!isTelemetryOptedIn()) return null;

  client = posthog.init(pendingConfig.apiKey, {
    api_host: "https://eu.i.posthog.com",
    // Persisted, not "memory": memory made `$session_id` fresh every launch and
    // broke every session-scoped metric. Only reachable once consent exists.
    persistence: "localStorage+cookie",
    autocapture: false,
    capture_pageview: false,
    // Session replay (item 12) starts below, by our own draw, never on its own.
    disable_session_recording: true,
    session_recording: { ...REPLAY_RECORDING_OPTIONS },
    // A console line or a request can carry a path or code: neither is kept.
    enable_recording_console_log: false,
    capture_performance: false,
    // @ts-ignore
    debug: import.meta.env.MODE === "development",
    before_send: (event) => {
      // Second layer, kept: consent can be withdrawn while the client runs.
      if (!isTelemetryOptedIn()) return null;
      // No longer blanking `$ip`: that is what PostHog resolves the country and
      // city from (the consent text says so). The project discards the address
      // itself after the lookup.
      // A replay never carries the user's folder (item 12, QA A14).
      if (event?.event === "$snapshot" && event.properties?.$snapshot_data) {
        event.properties.$snapshot_data = scrubReplayPaths(event.properties.$snapshot_data);
      }
      return event;
    },
  });
  posthog.identify(pendingConfig.analyticsId);
  // The main process stamps these on its events; the window's said surface null.
  posthog.register({
    surface: "app",
    ...(pendingConfig.appVersion ? { app_version: pendingConfig.appVersion } : {}),
  });
  startReplayIfDrawn();
  return client;
}

/** Record this launch if it is drawn, only ever with consent (item 12). */
function startReplayIfDrawn(): void {
  if (!client || !isTelemetryOptedIn()) return;
  const rate = pendingConfig?.replaySampleRate ?? REPLAY_SAMPLE_RATE;
  if (replayDrawn === null) replayDrawn = random() < rate;
  // `sampling: true`: this draw is the sampling, not the project's on top of it.
  if (replayDrawn && !replayOn) {
    posthog.startSessionRecording({ sampling: true });
    replayOn = true;
  }
}

/**
 * After a consent change. Withdrawn: a running recording stops at once, not at
 * the next launch (before_send drops whatever is still queued). Given: start.
 */
export function syncPostHogConsent(): void {
  if (client && !isTelemetryOptedIn()) {
    if (replayOn) posthog.stopSessionRecording();
    replayOn = false;
    return;
  }
  if (client) startReplayIfDrawn();
  else ensurePostHogInitialized();
}

/** Test seam — drops all module state. */
export function __resetPostHogClientForTests(draw: () => number = Math.random): void {
  client = null;
  pendingConfig = null;
  replayDrawn = null;
  replayOn = false;
  random = draw;
}
