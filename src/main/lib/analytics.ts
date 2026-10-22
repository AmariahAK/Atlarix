/**
 * Main-process PostHog analytics. Only sends events when the user has opted in
 * (`telemetryConsent === 'opted_in'`).
 *
 * Identity: a persistent anonymous id in `userData/analytics-id.json` while
 * signed out. ON SIGN-IN THAT STOPS BEING ANONYMOUS — `identifyUser` aliases the
 * id to the Supabase user id and `SubscriptionManager` sends `email` and `name`
 * with it (owner decision, so accounts are identifiable in the PostHog UI).
 *
 * This header used to end "(no email, name, or identifiable data)", which the
 * code 95 lines below had already contradicted, and the same false claim reached
 * a published changelog. Still never sent, and this part is real: code, prompts,
 * file names, file contents.
 */

import path from "node:path";
import fs from "node:fs";
import { app } from "electron";
import { PostHog } from "posthog-node";
import { readSettings, writeSettings } from "../settings";
import { v4 as uuidv4 } from "uuid";
import { atlarixEditor, atlarixSurface } from "@/ipc/shared/core_proxy";
import { drainTurnStats, type AutoBilling } from "@/lib/analytics/turn-stats";
import { isCoreAutoTier } from "@/ipc/shared/compass_constants";
import type { TurnEnd, TurnErrorKind } from "@/lib/analytics/turn-end";

const ANALYTICS_ID_FILE = "analytics-id.json";
const POSTHOG_HOST = "https://eu.i.posthog.com";

/**
 * Where events go: PostHog, or a stub on this machine for a live test
 * (`ATLARIX_POSTHOG_HOST=http://127.0.0.1:<port>`). Only a loopback address
 * is honoured, so the variable can never send anyone's usage elsewhere.
 */
export function posthogHost(env: string | undefined = process.env.ATLARIX_POSTHOG_HOST): string {
  return env && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(env) ? env.replace(/\/$/, "") : POSTHOG_HOST;
}

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
  // The editor running us has its own telemetry switched off (VS Code passes
  // this): nothing is sent, whatever the Atlarix answer.
  if (process.env.ATLARIX_HOST_TELEMETRY === "off") return false;
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
  // `disableGeoip: false`: posthog-node turns GeoIP OFF by default, which left
  // every desktop and CLI event without a country. The request comes from the
  // user's own machine, so the location is theirs; the project discards the IP
  // itself after the lookup (the consent text says both).
  // Batched: up to 20 events or 30 s per request, not one request per event.
  // The CLI and ACP still send what is queued on exit (flushAndClose).
  client = new PostHog(apiKey, {
    host: posthogHost(),
    disableGeoip: false,
    flushAt: 20,
    flushInterval: 30_000,
  });
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
      // This account's first sign-in on this install: Core is now usable here.
      void trackModelConnected({ type: "core", provider: "compass" });
    }
    posthog.identify({ distinctId: userId, properties: withInternalFlag(properties) });
  } catch {
    /* analytics must never break sign-in */
  }
}

/**
 * Our own and test accounts, marked on the person so PostHog's "filter out
 * internal and test users" drops them (filter: `internal = true`). Their usage
 * outnumbered real users' in every chart.
 */
const INTERNAL_EMAILS = new Set([
  "amariah.abish@gmail.com",
  "amariah@atlarix.dev",
  "amani.kamau06@gmail.com",
  "agent@atlarix.dev",
  "mojo.alexander3@gmail.com",
]);

function withInternalFlag(properties?: Record<string, unknown>): Record<string, unknown> | undefined {
  const email = properties?.email;
  if (typeof email !== "string") return properties;
  return { ...properties, internal: INTERNAL_EMAILS.has(email.trim().toLowerCase()) };
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
  posthog.capture({
    distinctId: resolveDistinctId(),
    event,
    properties: { ...superProperties(), ...properties },
  });
}

/**
 * On every event: which Atlarix sent it (app, cli, or an editor: acp for Zed
 * and JetBrains, vscode for our panel), the editor, the version and platform.
 * Before this an editor's events all said `cli`.
 */
function superProperties(): Record<string, unknown> {
  const editor = atlarixEditor();
  let version: string | undefined;
  try {
    version = app.getVersion();
  } catch {
    /* no app in this process */
  }
  return {
    surface: atlarixSurface(),
    ...(editor ? { editor } : {}),
    ...(version ? { app_version: version } : {}),
    os: process.platform,
    arch: process.arch,
  };
}

/**
 * A session rating or `/feedback` from someone signed out, sent whatever the
 * analytics answer: answering is the consent for this one event, and the card
 * says what it sends (owner, 2026-10-22). Nothing ties it to anyone: a fresh id
 * per event, no person profile, no location, no address.
 */
export function captureAnonymousFeedback(properties: Record<string, unknown>): boolean {
  try {
    const posthog = getPostHog();
    if (!posthog) return false;
    posthog.capture({
      distinctId: uuidv4(),
      event: "session_feedback",
      disableGeoip: true,
      properties: {
        ...superProperties(),
        ...properties,
        $process_person_profile: false,
        $ip: null,
      },
    });
    return true;
  } catch {
    return false;
  }
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

const connectedThisProcess = new Set<string>();

/** A user wired up a usable model: a key, a provider of their own, a local runtime, or Core. */
export type ModelConnectedType = "byok" | "custom" | "local" | "core";

/**
 * `model_connected`, one shape from every place a model is connected:
 * `{type, provider, provider_type}`, the provider normalised as on
 * turn_completed (a provider the user added is `custom`, never its own name).
 */
export function trackModelConnected(c: {
  type: ModelConnectedType;
  provider: string;
  /** A provider the user added: the API it speaks, or how to look it up (only for people who opted in). */
  apiFormat?: string | (() => Promise<string | undefined>);
}): Promise<void> {
  try {
    if (!isOptedIn()) return Promise.resolve();
    // Adding a provider and then its key is one connection, not two.
    if (connectedThisProcess.has(c.provider)) return Promise.resolve();
    connectedThisProcess.add(c.provider);
    // Returned so a command that exits right after (`atlarix keys add`) can wait for the capture.
    return (async () => {
      const format = typeof c.apiFormat === "function" ? await c.apiFormat().catch(() => undefined) : c.apiFormat;
      const p = providerFields(c.provider, c.type === "custom" ? "custom" : undefined, format);
      captureSafe("model_connected", { type: c.type, ...p });
    })().catch(() => {});
  } catch {
    /* analytics must never break connecting a model */
    return Promise.resolve();
  }
}

/** A provider the user added is stored as `custom::<their id>` (language_model_helpers). */
const CUSTOM_PREFIX = "custom::";

/**
 * The provider as reported: a built-in id as is; one the user added is
 * `custom`, with `provider_type` `custom:<api format>`. Its id is free text
 * the user typed and its address is theirs, so neither is ever sent.
 */
export function providerFields(
  providerId: string,
  providerType?: string,
  apiFormat?: string,
): { provider: string; provider_type: string } {
  if (providerType === "custom" || providerId.startsWith(CUSTOM_PREFIX)) {
    return { provider: "custom", provider_type: `custom:${apiFormat === "anthropic" ? "anthropic" : "openai"}` };
  }
  return { provider: providerId, provider_type: providerId };
}

/**
 * Which Core a Core turn ran on, in the proxy's own words (`usage_daily`):
 * Atlarix Auto free or paid (the proxy's reply says which), or a Core model.
 * Absent for an Auto turn that got no reply to read it from.
 */
export function corePlanOf(model: string | undefined, autoBilling: AutoBilling | undefined): string | undefined {
  if (!isCoreAutoTier(model)) return "core";
  return autoBilling ? `auto_${autoBilling}` : undefined;
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
    void trackModelConnected({ type: "local", provider: providerId });
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
    const today = localDayKey();
    const settings = readSettings();
    if (settings.lastActiveDay !== today) writeSettings({ lastActiveDay: today });
    // The event has its own marker: one marker for both lost the day whenever it
    // began with analytics off and they were turned on later that day.
    if (settings.lastActiveDaySent === today || !isOptedIn()) return;
    writeSettings({ lastActiveDaySent: today });
    captureSafe("active_day", { date: today });
  } catch {
    /* analytics must never break startup */
  }
}


/** Who pays for a turn's model: Atlarix Core, the user's own key, or a model on their machine. */
export type TurnBilling = "core" | "byok" | "local";

export function billingOf(provider: string, providerType?: string): TurnBilling {
  if (provider === "compass") return "core";
  if (providerType === "local") return "local";
  return "byok";
}

/** The per-chat choices of the last reported turn, for `changed`. */
const lastChoice = new Map<number, { mode?: string; model?: string; effort?: string }>();
/** Turns reported per chat in this process. */
const turnsInProcess = new Map<number, number>();

/** The mode as people see it: the code's "ask" is Explore everywhere in the UI. */
function modeName(mode: string | undefined): string | undefined {
  return mode === "ask" ? "explore" : mode;
}

function turnIndexBucket(n: number): string {
  if (n <= 1) return "1";
  if (n <= 5) return "2-5";
  if (n <= 20) return "6-20";
  return "21+";
}

/** Coarse duration buckets: a raw duration on a low-volume event is closer to a fingerprint than a metric. */
export function durationBucket(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return "<10s";
  if (s < 30) return "10-30s";
  if (s < 120) return "30s-2m";
  if (s < 600) return "2-10m";
  return ">10m";
}

/** One finished turn, as the stream saw it. No content. */
export interface TurnReport {
  chatId: number;
  end: TurnEnd;
  mode?: string;
  provider?: string;
  model?: string;
  effort?: string;
  fellBackToCore?: boolean;
  automation?: boolean;
  durationMs: number;
  /** The chat had messages before this turn (a resumed or continued chat). */
  hadHistory: boolean;
  outputTokens: number;
}

/**
 * `turn_completed`: one per turn, on every surface, with everything about the
 * turn: how it ended and why, the mode, model, effort and who paid, what
 * changed since the chat's last turn, and how many approvals, compactions,
 * sub-agents and retries it took. Switches and approvals are fields here, not
 * events of their own; `model_turn` and the renderer's `core_turn_*` are gone.
 *
 * Called after the turn has ended. The counters are drained whatever the
 * consent (they must not pile up); everything else, the provider lookup
 * included, happens only for people who opted in. Returns how the turn
 * really ended (the stream's own error over the SDK's stand-in), which the
 * crash report and the usage rollup read whatever the consent.
 */
export function trackTurnCompleted(
  r: TurnReport,
  providerTypeOf?: (providerId: string) => Promise<string | { type?: string; apiFormat?: string } | undefined>,
): TurnEnd & { autoBilling?: AutoBilling } {
  let resolved: TurnEnd & { autoBilling?: AutoBilling } = r.end;
  try {
    const stats = drainTurnStats(r.chatId);
    const prev = lastChoice.get(r.chatId);
    const choice = { mode: r.mode, model: r.model, effort: r.effort };
    lastChoice.set(r.chatId, choice);
    const n = (turnsInProcess.get(r.chatId) ?? 0) + 1;
    turnsInProcess.set(r.chatId, n);

    let { outcome, errorKind, httpStatus } = r.end;
    const se = stats.streamError;
    // The stream saw the real failure; the turn only saw the SDK's stand-in.
    if (se && outcome === "error" && (errorKind === "no_output" || errorKind === "other")) {
      errorKind = se.kind as TurnErrorKind;
      httpStatus = se.httpStatus;
    } else if (se && outcome === "ok" && r.outputTokens === 0) {
      outcome = "error";
      errorKind = se.kind as TurnErrorKind;
      httpStatus = se.httpStatus;
    }
    resolved = {
      outcome,
      ...(errorKind ? { errorKind } : {}),
      ...(httpStatus ? { httpStatus } : {}),
      ...(stats.autoBilling ? { autoBilling: stats.autoBilling } : {}),
    };
    if (!isOptedIn()) return resolved;

    const changed = prev ? (["mode", "model", "effort"] as const).filter((k) => prev[k] !== choice[k]) : [];

    void (async () => {
      const looked =
        r.provider && !r.fellBackToCore ? await providerTypeOf?.(r.provider).catch(() => undefined) : undefined;
      const providerType = typeof looked === "string" ? looked : looked?.type;
      const apiFormat = typeof looked === "string" ? undefined : looked?.apiFormat;
      const reported = r.fellBackToCore
        ? providerFields("compass")
        : r.provider
          ? providerFields(r.provider, providerType, apiFormat)
          : undefined;
      const provider = reported?.provider;
      const billing: TurnBilling | undefined = r.fellBackToCore
        ? "core"
        : r.provider
          ? billingOf(r.provider, providerType)
          : undefined;
      const corePlan = billing === "core" ? corePlanOf(r.model, stats.autoBilling) : undefined;
      const which = {
        ...(reported ? { provider_type: reported.provider_type } : {}),
        ...(corePlan ? { core_plan: corePlan } : {}),
      };
      const durationBucketValue = durationBucket(r.durationMs);
      captureSafe("turn_completed", {
        outcome,
        ...(errorKind ? { error_kind: errorKind } : {}),
        ...(httpStatus ? { http_status: httpStatus } : {}),
        ...(se && outcome === "ok" ? { recovered_error_kind: se.kind } : {}),
        ...(r.mode ? { mode: modeName(r.mode) } : {}),
        ...(provider ? { provider } : {}),
        ...which,
        ...(r.model ? { model: r.model } : {}),
        ...(billing ? { billing } : {}),
        effort: r.effort ?? "none",
        ...(r.fellBackToCore ? { fell_back_to_core: true } : {}),
        origin: r.automation ? "automation" : "user",
        changed,
        ...(changed.includes("mode") ? { prev_mode: modeName(prev?.mode) } : {}),
        ...(changed.includes("model") ? { prev_model: prev?.model } : {}),
        duration_bucket: durationBucketValue,
        turn_index_bucket: turnIndexBucket(n),
        resumed_session: n === 1 && r.hadHistory,
        ...stats.counts,
        ...(stats.loop ?? {}),
        ...(billing
          ? {
              $set: {
                last_billing: billing,
                last_provider: provider,
                ...(billing === "byok" ? { uses_byok: true } : billing === "local" ? { uses_local: true } : { uses_core: true }),
              },
              ...(billing === "byok" ? { $set_once: { first_byok_at: new Date().toISOString() } } : {}),
            }
          : {}),
      });
      // The old activation funnel, one more release (5673ba5a), now with THIS
      // turn's billing. It used to read a global "last turn", which two turns
      // running at once mixed up.
      const funnel = {
        ...(r.mode ? { mode: modeName(r.mode) } : {}),
        ...(billing ? { billing, provider } : {}),
        ...which,
        ...(r.model ? { model: r.model } : {}),
        ...(stats.loop ? { iterations: stats.loop.iterations, toolExecutions: stats.loop.tool_count } : {}),
        duration_bucket: durationBucketValue,
      };
      const settings = readSettings();
      if (!settings.firstTaskStartedAt) {
        writeSettings({ firstTaskStartedAt: Date.now() });
        captureSafe("first_task_started", funnel);
      }
      if (outcome === "ok") {
        if (!settings.firstTaskCompletedAt) {
          writeSettings({ firstTaskCompletedAt: Date.now() });
          captureSafe("first_task_completed", funnel);
        } else {
          captureSafe("task_completed", funnel);
        }
      }
    })().catch(() => {});
  } catch {
    /* analytics must never break the turn */
  }
  return resolved;
}

let lastTierSent: string | null = null;

/**
 * The account's tier, sent when it CHANGES in this process (sign-in, an
 * upgrade), as an event and a person property. It used to be sent on every
 * session refresh: 274 events from 21 people in a month.
 */
export function trackTier(tier: string): void {
  if (!tier || tier === lastTierSent) return;
  if (!isOptedIn()) return;
  lastTierSent = tier;
  captureSafe("tier_identified", { tier, $set: { tier } });
}

let sessionStarted = false;
/** A start that could not be sent yet (analytics off), sent once they come on. */
let pendingStart: Record<string, unknown> | null = null;

/** Once per process: the app opened, the CLI started, or an editor's first session. */
export function trackSessionStarted(properties?: Record<string, unknown>): void {
  if (sessionStarted) return;
  if (!isOptedIn()) {
    pendingStart ??= properties ?? {};
    return;
  }
  sessionStarted = true;
  pendingStart = null;
  captureSafe("session_started", properties);
}

/**
 * Analytics just came on (the consent answer, the CLI's /analytics, the
 * editor's own telemetry switch): this process's start and today's active day,
 * which were not sent while they were off, are sent now, once each.
 */
export function trackAnalyticsTurnedOn(): void {
  if (pendingStart && !sessionStarted) trackSessionStarted(pendingStart);
  trackActiveDay();
}

/**
 * Send what is queued now, not with the next batch: a session rating or
 * /feedback answered in a CLI killed before it exits was lost (QA, ai-b8).
 */
export function flushSoon(): void {
  try {
    void client?.flush();
  } catch {
    /* analytics must never break the UI */
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

/**
 * Send what is queued and close, WAITING for it: the CLI exits right after
 * (`shutdown` above only starts a flush, which the app outlives, a process
 * about to exit does not). Bounded by the caller.
 */
export async function flushAndClose(): Promise<void> {
  const c = client;
  client = null;
  if (c) await c.shutdown();
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
