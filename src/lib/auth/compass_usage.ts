import log from "electron-log";
import * as Sentry from "@sentry/electron/main";
import type { CompassUsageIpcResult } from "../../ipc/ipc_types";
import { getSupabaseClient } from "./supabase-client";

const logger = log.scope("compass_usage");

/** Normalize AI SDK / provider usage into a single token count for Compass metering. */
export function totalTokensFromAiUsage(
  usage:
    | {
        totalTokens?: number;
        promptTokens?: number;
        completionTokens?: number;
        inputTokens?: number;
        outputTokens?: number;
      }
    | undefined
    | null,
): number | null {
  if (!usage) return null;
  if (typeof usage.totalTokens === "number" && usage.totalTokens > 0) {
    return Math.round(usage.totalTokens);
  }
  const p =
    typeof usage.promptTokens === "number"
      ? usage.promptTokens
      : typeof usage.inputTokens === "number"
        ? usage.inputTokens
        : null;
  const c =
    typeof usage.completionTokens === "number"
      ? usage.completionTokens
      : typeof usage.outputTokens === "number"
        ? usage.outputTokens
        : null;
  if (p != null && c != null && p + c > 0) {
    return Math.round(p + c);
  }
  return null;
}

/**
 * Returns current Compass usage for the signed-in user (applies 30-day reset in DB).
 * Distinguishes **no session** (`not_authenticated`) from **Supabase/RPC errors** so the renderer
 * does not show “sign in” when the user is logged in but SQL/migrations are missing.
 */
export async function getCompassUsageFromSupabase(): Promise<CompassUsageIpcResult> {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc("get_compass_usage_state");
    if (error) {
      logger.warn("[compass] get_compass_usage_state:", error.message);
      Sentry.captureException(
        new Error(`Compass get_compass_usage_state: ${error.message}`),
        { tags: { feature: "compass", compass_op: "get_usage" } },
      );
      const missingFn = /could not find the function|schema cache|does not exist/i.test(
        error.message,
      );
      return {
        ok: false,
        reason: "rpc_error",
        message: missingFn
          ? "Compass usage is not set up on this Supabase project yet. Open docs/compass-limits.md and run the full SQL in the Supabase SQL Editor, then reload the app."
          : error.message,
      };
    }
    const row = data as {
      ok?: boolean;
      error?: string;
      tokens_used_this_month?: number;
      monthly_limit?: number;
      tier?: string;
    } | null;
    if (!row || row.ok === false) {
      if (row?.error === "not_authenticated") {
        return { ok: false, reason: "not_authenticated" };
      }
      return {
        ok: false,
        reason: "rpc_error",
        message: row?.error ?? "get_compass_usage_state returned error",
      };
    }
    return {
      ok: true,
      tokensUsedThisMonth: Number(row.tokens_used_this_month ?? 0),
      monthlyLimit: Number(row.monthly_limit ?? 0),
      tier: String(row.tier ?? "free"),
    };
  } catch (e) {
    logger.warn("[compass] getCompassUsageFromSupabase:", e);
    Sentry.captureException(e instanceof Error ? e : new Error(String(e)), {
      tags: { feature: "compass", compass_op: "get_usage" },
    });
    return {
      ok: false,
      reason: "rpc_error",
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

export type RecordCompassResult =
  | { ok: true }
  | { ok: false; error: "limit_exceeded" | "not_authenticated" | "rpc_error"; message?: string };

/**
 * Persists token usage from the OpenRouter/API response (total_tokens for the exchange).
 */
export async function recordCompassUsageTokens(totalTokens: number): Promise<RecordCompassResult> {
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) {
    return { ok: true };
  }
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc("record_compass_usage", {
      p_tokens: Math.round(totalTokens),
    });
    if (error) {
      logger.warn("[compass] record_compass_usage:", error.message);
      Sentry.captureException(
        new Error(`Compass record_compass_usage: ${error.message}`),
        {
          tags: { feature: "compass", compass_op: "record_usage" },
          extra: { totalTokens: Math.round(totalTokens) },
        },
      );
      return { ok: false, error: "rpc_error", message: error.message };
    }
    const row = data as {
      ok?: boolean;
      error?: string;
    } | null;
    if (!row?.ok) {
      if (row?.error === "limit_exceeded") {
        Sentry.captureMessage("Compass monthly limit exceeded on record", {
          level: "info",
          tags: { feature: "compass", compass_op: "limit_exceeded" },
          extra: { totalTokens: Math.round(totalTokens) },
        });
        return { ok: false, error: "limit_exceeded" };
      }
      if (row?.error === "not_authenticated") {
        return { ok: false, error: "not_authenticated" };
      }
      Sentry.captureMessage(`Compass record_compass_usage rejected: ${row?.error}`, {
        level: "warning",
        tags: { feature: "compass", compass_op: "record_usage" },
        extra: { totalTokens: Math.round(totalTokens), rpcError: row?.error },
      });
      return { ok: false, error: "rpc_error", message: row?.error };
    }
    return { ok: true };
  } catch (e) {
    logger.warn("[compass] recordCompassUsageTokens:", e);
    Sentry.captureException(e instanceof Error ? e : new Error(String(e)), {
      tags: { feature: "compass", compass_op: "record_usage" },
      extra: { totalTokens: Math.round(totalTokens) },
    });
    return { ok: false, error: "rpc_error", message: e instanceof Error ? e.message : String(e) };
  }
}
