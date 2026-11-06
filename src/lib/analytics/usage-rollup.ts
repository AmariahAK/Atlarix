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
 * Each turn also writes this process's unsent counts to
 * <userData>/usage-pending/<pid>.json. A process that never reaches its send
 * (killed, crashed, a Windows sign-out or shutdown, an installer restart) used
 * to lose them, and the morning list then said "opened, no turn yet" about an
 * account that had run one (2026-11-03). The next process to start adopts the
 * files of processes that are gone and sends them with its own.
 *
 * Counts only: never what was said, a key, or a provider the user named.
 */
import fs from "node:fs";
import path from "node:path";
import { atlarixEditor, atlarixSurface } from "@/ipc/shared/core_proxy";
import { getUserDataPath } from "@/paths/paths";
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
  /** Turns refused at a gate (no credit, the free limit, consent, a rule): not errors, not successes. */
  gated_turns: number;
  last_gate_kind?: string;
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
/** Rows handed to a send that has not answered yet: still on disk until it does. */
let inflight: UsageRow[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let sendImpl: Send = sendToSupabase;
/** This process has written its own pending file (so a file with our pid is ours, not a predecessor's). */
let wroteOwn = false;
let adopting: Promise<void> | null = null;

function pendingDir(): string {
  return path.join(getUserDataPath(), "usage-pending");
}

function ownFile(): string {
  return path.join(pendingDir(), `${process.pid}.json`);
}

/** This process's unsent counts, on disk: written whole, then renamed into place. */
function persist(): void {
  try {
    const f = ownFile();
    const all = [...inflight, ...rows.values()];
    if (!all.length) {
      if (wroteOwn) fs.rmSync(f, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all));
    fs.renameSync(tmp, f);
    wroteOwn = true;
  } catch {
    /* counting must never break the turn */
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists, under another user.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRow(r: unknown): r is UsageRow {
  const x = r as Partial<UsageRow> | null;
  return (
    !!x &&
    typeof x.day === "string" &&
    DAY_RE.test(x.day) &&
    typeof x.surface === "string" &&
    typeof x.editor === "string" &&
    typeof x.billing === "string" &&
    typeof x.provider_type === "string" &&
    typeof x.model === "string" &&
    typeof x.turns === "number" &&
    x.turns >= 1 &&
    typeof x.failed_turns === "number" &&
    typeof x.tokens_in === "number" &&
    typeof x.tokens_out === "number" &&
    typeof x.first_seen === "string" &&
    typeof x.last_seen === "string"
  );
}

/**
 * Take the unsent counts of processes that are gone, once per process. A file
 * is claimed by renaming it (only one process can), merged, written to our own
 * file, and only then removed, so a kill in between repeats nothing worse than
 * a claim file the next start clears. Rows from before yesterday are dropped:
 * the server refuses them.
 */
export function adoptPendingUsage(): Promise<void> {
  adopting ??= Promise.resolve().then(adoptOnce).catch(() => {});
  return adopting;
}

function adoptOnce(): void {
  if (!enabled()) return;
  const dir = pendingDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const oldest = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const claims: string[] = [];
  for (const name of names) {
    const full = path.join(dir, name);
    // A write or a claim that a process gone since never finished: its rows are
    // in that process's own file already (or were never complete).
    const leftover = /^(\d+)\.json(?:\.tmp|\.claimed-(\d+))$/.exec(name);
    if (leftover) {
      const owner = Number(leftover[2] ?? leftover[1]);
      if (owner !== process.pid && !alive(owner)) fs.rmSync(full, { force: true });
      continue;
    }
    const m = /^(\d+)\.json$/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid ? wroteOwn : alive(pid)) continue;
    const claim = `${full}.claimed-${process.pid}`;
    try {
      fs.renameSync(full, claim);
    } catch {
      continue; // another process claimed it first
    }
    claims.push(claim);
    let list: unknown = [];
    try {
      list = JSON.parse(fs.readFileSync(claim, "utf8"));
    } catch {
      /* unreadable: nothing to take */
    }
    if (Array.isArray(list)) for (const r of list) if (isRow(r) && r.day >= oldest) restore(r);
  }
  if (!claims.length) return;
  persist();
  for (const c of claims) fs.rmSync(c, { force: true });
  if (rows.size) armTimer();
}

function armTimer(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flushClientUsage();
  }, FLUSH_AFTER_MS);
  timer.unref?.();
}

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
    void adoptPendingUsage();
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
        gated: t.end.outcome === "gate",
        gateKind: t.end.outcome === "gate" ? (t.end as { gateKind?: string }).gateKind ?? "other" : undefined,
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
  gated?: boolean;
  gateKind?: string;
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
    if (x.gated) {
      r.gated_turns++;
      r.last_gate_kind = x.gateKind;
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
      gated_turns: x.gated ? 1 : 0,
      ...(x.gateKind ? { last_gate_kind: x.gateKind } : {}),
      tokens_in: Math.max(0, x.tokensIn),
      tokens_out: Math.max(0, x.tokensOut),
      first_seen: at,
      last_seen: at,
    });
  }
  persist();
  armTimer();
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
  inflight = batch;
  try {
    for (let i = 0; i < batch.length; i += BATCH) {
      const part = batch.slice(i, i + BATCH);
      const ok = await sendImpl(part).catch(() => false);
      if (!ok) {
        inflight = [];
        for (const r of [...part, ...batch.slice(i + BATCH)]) restore(r);
        return;
      }
      inflight = batch.slice(i + BATCH);
    }
  } finally {
    inflight = [];
    persist();
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
  now.gated_turns += r.gated_turns ?? 0;
  now.last_gate_kind ??= r.last_gate_kind;
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
  inflight = [];
  wroteOwn = false;
  adopting = null;
  if (timer) clearTimeout(timer);
  timer = null;
}

export function __pendingUsageRowsForTests(): UsageRow[] {
  return [...rows.values()];
}
