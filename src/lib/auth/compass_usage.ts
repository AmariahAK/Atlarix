import log from "electron-log";
import * as Sentry from "@sentry/electron/main";
import type { CompassUsageIpcResult } from "../../ipc/ipc_types";
import { getSupabaseClient } from "./supabase-client";
import { isLikelyNetworkFailure } from "./network-failure";

const logger = log.scope("compass_usage");

export type LooseAiUsage = {
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  thinkingTokens?: number;
  completionTokensDetails?: { reasoningTokens?: number; thinkingTokens?: number };
  outputTokensDetails?: { reasoningTokens?: number; thinkingTokens?: number };
};

/** Best-effort reasoning / thinking token count from provider usage objects. */
export function reasoningTokensFromAiUsage(
  usage: LooseAiUsage | undefined | null,
): number | null {
  if (!usage) return null;
  const u = usage as Record<string, unknown>;
  const direct =
    (typeof usage.reasoningTokens === "number" ? usage.reasoningTokens : null) ??
    (typeof usage.thinkingTokens === "number" ? usage.thinkingTokens : null);
  if (typeof direct === "number" && direct > 0) {
    return Math.round(direct);
  }
  const ctd = usage.completionTokensDetails ?? usage.outputTokensDetails;
  if (ctd) {
    const r =
      (typeof ctd.reasoningTokens === "number" ? ctd.reasoningTokens : null) ??
      (typeof ctd.thinkingTokens === "number" ? ctd.thinkingTokens : null);
    if (typeof r === "number" && r > 0) return Math.round(r);
  }
  const nested = u["completion_tokens_details"] as { reasoning_tokens?: number } | undefined;
  if (nested && typeof nested.reasoning_tokens === "number" && nested.reasoning_tokens > 0) {
    return Math.round(nested.reasoning_tokens);
  }
  return null;
}

/** Normalize AI SDK / provider usage into a single token count for Compass metering. */
export function totalTokensFromAiUsage(
  usage: LooseAiUsage | undefined | null,
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
  const extra = reasoningTokensFromAiUsage(usage) ?? 0;
  if (p != null && c != null && p + c + extra > 0) {
    return Math.round(p + c + extra);
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
      if (isLikelyNetworkFailure(error)) {
        Sentry.captureMessage(`Compass get_compass_usage_state (network): ${error.message}`, {
          level: "warning",
          tags: { feature: "compass", compass_op: "get_usage", transient: "network" },
        });
      } else {
        Sentry.captureException(
          new Error(`Compass get_compass_usage_state: ${error.message}`),
          { tags: { feature: "compass", compass_op: "get_usage" } },
        );
      }
      if (isLikelyNetworkFailure(error)) {
        return {
          ok: false,
          reason: "network_error",
          message:
            "Could not reach Compass usage service. Check your connection; usage limits were not verified for this action.",
        };
      }
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
    if (isLikelyNetworkFailure(e)) {
      Sentry.captureMessage(
        `Compass get_compass_usage_state (network): ${e instanceof Error ? e.message : String(e)}`,
        {
          level: "warning",
          tags: { feature: "compass", compass_op: "get_usage", transient: "network" },
        },
      );
      return {
        ok: false,
        reason: "network_error",
        message:
          "Could not reach Compass usage service. Check your connection; usage limits were not verified for this action.",
      };
    }
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
      if (isLikelyNetworkFailure(error)) {
        Sentry.captureMessage(`Compass record_compass_usage (network): ${error.message}`, {
          level: "warning",
          tags: { feature: "compass", compass_op: "record_usage", transient: "network" },
          extra: { totalTokens: Math.round(totalTokens) },
        });
      } else {
        Sentry.captureException(
          new Error(`Compass record_compass_usage: ${error.message}`),
          {
            tags: { feature: "compass", compass_op: "record_usage" },
            extra: { totalTokens: Math.round(totalTokens) },
          },
        );
      }
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
    if (isLikelyNetworkFailure(e)) {
      Sentry.captureMessage(
        `Compass record_compass_usage (network): ${e instanceof Error ? e.message : String(e)}`,
        {
          level: "warning",
          tags: { feature: "compass", compass_op: "record_usage", transient: "network" },
          extra: { totalTokens: Math.round(totalTokens) },
        },
      );
    } else {
      Sentry.captureException(e instanceof Error ? e : new Error(String(e)), {
        tags: { feature: "compass", compass_op: "record_usage" },
        extra: { totalTokens: Math.round(totalTokens) },
      });
    }
    return { ok: false, error: "rpc_error", message: e instanceof Error ? e.message : String(e) };
  }
}
