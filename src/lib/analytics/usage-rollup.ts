/**
 * Turns per day, surface, provider type and model, for every signed-in
 * account (owner, 2026-10-21: "who is active and when"), written to Supabase
 * `client_usage_daily` through `record_client_usage` as the account itself.
 *
 * Not the analytics answer: like the proxy's usage records it is kept with the
 * account, and the consent text and privacy page say so. Off when the editor
 * running us has its own telemetry off (`ATLARIX_HOST_TELEMETRY=off`).
 *
 * Counted in memory per process; one call 15 minutes after the first turn
 * since the last call, and one at quit. Never per message, nothing while idle,
 * nothing signed out. Two processes on one profile each send their own turns
 * (the write adds). A call that fails keeps its counts for the next one.
 *
 * Counts only: never what was said, a key, or a provider the user named.
 */
import { atlarixEditor, atlarixSurface } from "@/ipc/shared/core_proxy";
import { billingOf, corePlanOf, providerFields } from "@/main/lib/analytics";
import type { TurnEnd } from "@/lib/analytics/turn-end";
import type { AutoBilling } from "@/lib/analytics/turn-stats";

export const FLUSH_AFTER_MS = 15 * 60_000;
/** Distinct rows kept between calls. A day of real use is a handful. */
const MAX_ROWS = 200;
/** Rows per call: the RPC refuses more. */
const BATCH = 50;

export interface UsageRow {
  day: string;
  surface: string;
  editor: string;
  billing: string;
  provider_type: string;
  model: string;
  turns: number;
  failed_turns: number;
  last_error_kind?: string;
  tokens_in: number;
  tokens_out: number;
  first_seen: string;
  last_seen: string;
}

export interface UsageTurn {
  end: TurnEnd & { autoBilling?: AutoBilling };
  provider?: string;
  model?: string;
  fellBackToCore?: boolean;
  tokensIn: number;
  tokensOut: number;
  at?: Date;
}

type Send = (rows: UsageRow[]) => Promise<boolean>;

const rows = new Map<string, UsageRow>();
let timer: ReturnType<typeof setTimeout> | null = null;
let sendImpl: Send = sendToSupabase;

function enabled(): boolean {
  return process.env.ATLARIX_HOST_TELEMETRY !== "off";
}

/** Who paid, in the proxy's words where it is Core (auto_free / auto_paid / core). */
function billingFor(t: UsageTurn, providerType: string | undefined): string {
  if (t.fellBackToCore) return "core";
  const b = billingOf(t.provider!, providerType);
  if (b !== "core") return b;
  return corePlanOf(t.model, t.end.autoBilling) ?? "auto";
}

/** Count one finished turn. Never throws, never waits on anything. */
export function recordTurnUsage(
  t: UsageTurn,
  providerOf?: (providerId: string) => Promise<{ type?: string; apiFormat?: string } | undefined>,
): void {
  try {
    if (!enabled() || !t.provider || !t.model) return;
    if (t.end.outcome === "stopped" || t.end.outcome === "aborted") return;
    void (async () => {
      const looked = t.fellBackToCore ? undefined : await providerOf?.(t.provider!).catch(() => undefined);
      const { provider_type } = t.fellBackToCore
        ? providerFields("compass")
        : providerFields(t.provider!, looked?.type, looked?.apiFormat);
      add({
        at: t.at ?? new Date(),
        billing: billingFor(t, looked?.type),
        provider_type,
        model: t.model!.slice(0, 128),
        failed: t.end.outcome === "error",
        errorKind: t.end.outcome === "error" ? t.end.errorKind ?? "other" : undefined,
        tokensIn: t.tokensIn,
        tokensOut: t.tokensOut,
      });
    })().catch(() => {});
  } catch {
    /* counting must never break the turn */
  }
}

function add(x: {
  at: Date;
  billing: string;
  provider_type: string;
  model: string;
  failed: boolean;
  errorKind?: string;
  tokensIn: number;
  tokensOut: number;
}): void {
  const day = x.at.toISOString().slice(0, 10);
  const surface = atlarixSurface();
  const editor = (atlarixEditor() ?? "").slice(0, 40);
  const key = [day, surface, editor, x.billing, x.provider_type, x.model].join("\u0000");
  const at = x.at.toISOString();
  const r = rows.get(key);
  if (r) {
    r.turns++;
    if (x.failed) {
      r.failed_turns++;
      r.last_error_kind = x.errorKind;
    }
    r.tokens_in += Math.max(0, x.tokensIn);
    r.tokens_out += Math.max(0, x.tokensOut);
    if (at > r.last_seen) r.last_seen = at;
  } else {
    if (rows.size >= MAX_ROWS) return;
    rows.set(key, {
      day,
      surface,
      editor,
      billing: x.billing,
      provider_type: x.provider_type,
      model: x.model,
      turns: 1,
      failed_turns: x.failed ? 1 : 0,
      ...(x.errorKind ? { last_error_kind: x.errorKind } : {}),
      tokens_in: Math.max(0, x.tokensIn),
      tokens_out: Math.max(0, x.tokensOut),
      first_seen: at,
      last_seen: at,
    });
  }
  if (!timer) {
    timer = setTimeout(() => {
      timer = null;
      void flushClientUsage();
    }, FLUSH_AFTER_MS);
    timer.unref?.();
  }
}

/**
 * Send what is counted. At quit the caller bounds the wait. A failed call puts
 * its rows back (added to anything counted meanwhile).
 */
export async function flushClientUsage(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!rows.size) return;
  const batch = [...rows.values()];
  rows.clear();
  for (let i = 0; i < batch.length; i += BATCH) {
    const part = batch.slice(i, i + BATCH);
    const ok = await sendImpl(part).catch(() => false);
    if (!ok) {
      for (const r of [...part, ...batch.slice(i + BATCH)]) restore(r);
      return;
    }
  }
}

function restore(r: UsageRow): void {
  const key = [r.day, r.surface, r.editor, r.billing, r.provider_type, r.model].join("\u0000");
  const now = rows.get(key);
  if (!now) {
    if (rows.size < MAX_ROWS) rows.set(key, r);
    return;
  }
  now.turns += r.turns;
  now.failed_turns += r.failed_turns;
  now.last_error_kind ??= r.last_error_kind;
  now.tokens_in += r.tokens_in;
  now.tokens_out += r.tokens_out;
  if (r.first_seen < now.first_seen) now.first_seen = r.first_seen;
  if (r.last_seen > now.last_seen) now.last_seen = r.last_seen;
}

/** As the signed-in account. Signed out: nothing is sent, and the counts are dropped. */
async function sendToSupabase(p_rows: UsageRow[]): Promise<boolean> {
  const { getSupabaseClient, getSession } = await import("@/lib/auth/supabase-client");
  if (!(await getSession())) return true;
  const { data, error } = await getSupabaseClient().rpc("record_client_usage", { p_rows } as never);
  return !error && (data as { ok?: boolean } | null)?.ok === true;
}

/** Tests: where rows go, and a clean slate. */
export function __setUsageSenderForTests(send: Send | null): void {
  sendImpl = send ?? sendToSupabase;
  rows.clear();
  if (timer) clearTimeout(timer);
  timer = null;
}

export function __pendingUsageRowsForTests(): UsageRow[] {
  return [...rows.values()];
}
