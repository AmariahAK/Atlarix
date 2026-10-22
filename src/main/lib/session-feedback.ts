/**
 * Sends a session rating or `/feedback` (lib/feedback/session-rating.ts), from
 * the main process on every surface: the app's main, the CLI, ACP.
 *
 * Signed in: Supabase `record_session_feedback`, as the caller's own account,
 * so the owner can follow up with the person. Signed out: one PostHog event
 * that names nobody (sendAnonymousFeedback). And with analytics on, a
 * `session_rated` event (the rating, no text) for the dashboards.
 *
 * Never a prompt, code or a key: the rating or the typed text, and the
 * session's shape.
 */
import os from "node:os";
import { app } from "electron";
import log from "electron-log";
import { atlarixEditor, atlarixSurface } from "@/ipc/shared/core_proxy";
import { isCoreAutoTier } from "@/ipc/shared/compass_constants";
import { FEEDBACK_MAX, RATINGS, type RatingKey } from "@/lib/feedback/session-rating";
import { readSettings, writeSettings } from "../settings";
import { captureSafe, flushSoon, providerFields, sendAnonymousFeedback } from "./analytics";

const logger = log.scope("session-feedback");

export type FeedbackAnswer = { kind: "rating"; rating: 1 | 2 | 3 } | { kind: "text"; body: string };

/** What the surface knows about the session being rated. */
export interface FeedbackSession {
  mode?: string;
  effort?: string;
  /** Provider id and model name, as the session's model choice holds them. */
  provider?: string;
  model?: string;
  turns?: number;
  startedAt?: number;
}

/** The rating was answered or dismissed: no surface asks again for a while. */
export function noteRatingAsked(now = Date.now()): void {
  try {
    writeSettings({ sessionRatingAt: now });
  } catch {
    /* a settings write must never break the turn */
  }
}

export function ratingAskedAt(): number | undefined {
  try {
    return readSettings().sessionRatingAt;
  } catch {
    return undefined;
  }
}

export function forceRating(): boolean {
  return process.env.ATLARIX_FORCE_RATING === "1";
}

const anonSent: number[] = [];
const ANON_PER_HOUR = 5;

export async function sendSessionFeedback(
  answer: FeedbackAnswer,
  session: FeedbackSession,
): Promise<{ ok: boolean; error?: string }> {
  const context = await contextOf(session);
  const body = answer.kind === "text" ? answer.body.trim().slice(0, FEEDBACK_MAX) : undefined;
  if (answer.kind === "text" && !body) return { ok: false, error: "empty" };

  if (answer.kind === "rating") {
    captureSafe("session_rated", {
      rating: RATINGS[String(answer.rating) as RatingKey],
      ...context,
    });
    flushSoon();
  }

  const { getSession, getSupabaseClient } = await import("@/lib/auth/supabase-client");
  const signedIn = await getSession().catch(() => null);
  if (!signedIn) {
    const now = Date.now();
    while (anonSent.length && now - anonSent[0]! > 60 * 60 * 1000) anonSent.shift();
    if (anonSent.length >= ANON_PER_HOUR) return { ok: false, error: "rate_limited" };
    // Answered by PostHog, or "not sent": the text stays to send again (QA A16).
    const sent = await sendAnonymousFeedback({
      kind: answer.kind,
      ...(answer.kind === "rating" ? { rating: answer.rating } : { body }),
      ...context,
    });
    if (!sent) {
      logger.warn("not recorded: the anonymous event was not accepted");
      return { ok: false, error: "not_sent" };
    }
    anonSent.push(now);
    return { ok: true };
  }

  try {
    const { data, error } = await getSupabaseClient().rpc("record_session_feedback", {
      p: {
        kind: answer.kind,
        ...(answer.kind === "rating" ? { rating: answer.rating } : { body }),
        ...context,
      },
    } as never);
    const res = data as { ok?: boolean; error?: string } | null;
    if (error || !res?.ok) {
      logger.warn(`not recorded: ${error?.message ?? res?.error ?? "no answer"}`);
      return { ok: false, error: res?.error ?? "not_sent" };
    }
    return { ok: true };
  } catch (e) {
    logger.warn(`not recorded: ${(e as Error).message}`);
    return { ok: false, error: "not_sent" };
  }
}

/** The session's shape, in the table's fields. A provider the user named is `custom`. */
async function contextOf(s: FeedbackSession): Promise<Record<string, string | number>> {
  let version = "";
  try {
    version = app.getVersion();
  } catch {
    /* no app in this process */
  }
  const out: Record<string, string | number> = {
    surface: atlarixSurface(),
    editor: atlarixEditor(),
    app_version: version || "0.0.0",
    os: os.platform(),
  };
  if (s.provider) {
    const looked = await import("@/ipc/shared/language_model_helpers")
      .then(async (m) => (await m.getLanguageModelProviders()).find((p) => p.id === s.provider))
      .catch(() => undefined);
    out.provider = providerFields(s.provider, looked?.type, looked?.apiFormat).provider;
    out.provider_type =
      s.provider === "compass"
        ? isCoreAutoTier(s.model)
          ? "auto"
          : "core"
        : looked?.type === "local"
          ? "local"
          : "byok";
  }
  if (s.model) out.model = s.model.slice(0, 128);
  if (s.mode) out.mode = s.mode === "ask" ? "explore" : s.mode;
  if (s.effort) out.effort = s.effort;
  if (typeof s.turns === "number") out.turns = s.turns;
  if (s.startedAt) out.session_minutes = Math.max(0, Math.round((Date.now() - s.startedAt) / 60_000));
  return out;
}
