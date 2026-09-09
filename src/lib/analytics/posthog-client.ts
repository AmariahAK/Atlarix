import posthog from "posthog-js";
import { isTelemetryOptedIn } from "@/hooks/useSettings";

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
let pendingConfig: { apiKey: string; analyticsId: string } | null = null;

/** The live client, or null while the user has not opted in. */
export function getPostHogClient(): ReturnType<typeof posthog.init> | null {
  return client;
}

/** Remember the config without starting anything. */
export function setPostHogConfig(apiKey: string, analyticsId: string): void {
  pendingConfig = { apiKey, analyticsId };
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
    disable_session_recording: true,
    // @ts-ignore
    debug: import.meta.env.MODE === "development",
    before_send: (event) => {
      // Second layer, kept: consent can be withdrawn while the client runs.
      if (!isTelemetryOptedIn()) return null;
      if (event?.properties?.["$ip"]) event.properties["$ip"] = null;
      return event;
    },
  });
  posthog.identify(pendingConfig.analyticsId);
  return client;
}

/** Test seam — drops all module state. */
export function __resetPostHogClientForTests(): void {
  client = null;
  pendingConfig = null;
}
