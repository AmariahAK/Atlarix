/**
 * The Usage page's Credits tab: the signed-in account's Atlarix spend per local
 * day (Auto paid and Core apart), the balance left, and for Pro the allowance
 * and its reset date. Atlarix credits only; a BYOK turn costs the account
 * nothing and is never here.
 *
 * One `get_usage_credits` RPC, as the account itself (own rows only). Shared by
 * concurrent callers and reused for a minute, like credit-balance.
 */
import { getSession, getSupabaseClient } from "@/lib/auth/supabase-client";

export type { UsageCredits, UsageCreditsDay } from "@/lib/stats/usage-types";
import type { UsageCredits, UsageTeam } from "@/lib/stats/usage-types";

const cents = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;

/** The RPC's body as the tab reads it; anything malformed is "unavailable", never zeros. */
export function parseUsageCredits(data: unknown): UsageCredits {
  const d = data as Record<string, unknown> | null;
  if (!d || d.ok !== true || typeof d.balance_cents !== "number")
    return { state: "unavailable" };
  const days = Array.isArray(d.days) ? d.days : [];
  return {
    state: "ok",
    balanceCents: Math.round(d.balance_cents),
    purchasedCents: cents(d.purchased_cents),
    grantedCents: cents(d.granted_cents),
    grantedTotalCents: cents(d.granted_total_cents),
    plan: d.plan === "pro" ? "pro" : "free",
    renewsAt:
      typeof d.renews_at === "string" && d.renews_at ? d.renews_at : null,
    since: typeof d.since === "string" && d.since ? d.since : null,
    days: days
      .filter(
        (x): x is Record<string, unknown> =>
          !!x &&
          typeof x === "object" &&
          typeof (x as { day?: unknown }).day === "string",
      )
      .map((x) => ({
        day: String(x.day),
        autoPaidCents: cents(x.auto_paid_cents),
        coreCents: cents(x.core_cents),
        toolCents: cents(x.tool_cents),
        otherCents: cents(x.other_cents),
        unsplitCents: cents(x.unsplit_cents),
      }))
      .sort((a, b) => a.day.localeCompare(b.day)),
  };
}

/** This computer's IANA zone, so the server buckets spend into the user's own days. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** `YYYY-MM` of this calendar month and the one before, on this computer's clock. */
export function monthKeys(now: Date): { thisMonth: string; lastMonth: string } {
  const key = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  return {
    thisMonth: key(now),
    lastMonth: key(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
  };
}

/** Days back to the first of last month, so "last month" is whole. */
export function daysSinceLastMonthStart(now: Date): number {
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return Math.ceil((now.getTime() - start.getTime()) / 86_400_000) + 1;
}

type MonthTotals = { thisMonthCents: number; lastMonthCents: number };

function addToMonth<K extends string>(
  by: Map<K, MonthTotals>,
  key: K,
  day: string,
  cents: number,
  months: { thisMonth: string; lastMonth: string },
): void {
  const m = day.slice(0, 7);
  if (m !== months.thisMonth && m !== months.lastMonth) return;
  const t = by.get(key) ?? { thisMonthCents: 0, lastMonthCents: 0 };
  if (m === months.thisMonth) t.thisMonthCents += cents;
  else t.lastMonthCents += cents;
  by.set(key, t);
}

const text = (v: unknown, fallback: string) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : fallback;

/** get_usage_team as the Credits tab reads it: per member and per channel, this month and last. */
export function parseUsageTeam(
  data: unknown,
  now: Date,
): UsageTeam | undefined {
  const d = data as { ok?: unknown; rows?: unknown; members?: unknown } | null;
  if (!d || d.ok !== true || !Array.isArray(d.rows) || d.rows.length === 0)
    return undefined;
  const months = monthKeys(now);
  const members = new Map<string, MonthTotals>();
  const channels = new Map<string, MonthTotals>();
  for (const r of d.rows as Array<Record<string, unknown>>) {
    if (!r || typeof r.day !== "string") continue;
    const c = cents(r.cents);
    addToMonth(members, text(r.member, "Unknown"), r.day, c, months);
    // A DM comes as no channel or as "dm".
    const channel = text(r.channel, "Direct messages");
    addToMonth(
      channels,
      channel.toLowerCase() === "dm" ? "Direct messages" : channel,
      r.day,
      c,
      months,
    );
  }
  const tasks = new Map<string, number>();
  for (const m of (Array.isArray(d.members) ? d.members : []) as Array<
    Record<string, unknown>
  >) {
    if (m)
      tasks.set(
        text(m.member, "Unknown"),
        Math.max(0, Math.round(Number(m.tasks) || 0)),
      );
  }
  const ranked = <T extends MonthTotals>(xs: T[]) =>
    xs.sort(
      (a, b) =>
        b.thisMonthCents - a.thisMonthCents ||
        b.lastMonthCents - a.lastMonthCents,
    );
  return {
    members: ranked(
      [...members].map(([member, t]) => ({
        member,
        tasks: tasks.get(member) ?? 0,
        ...t,
      })),
    ),
    channels: ranked([...channels].map(([channel, t]) => ({ channel, ...t }))),
  };
}

/** get_usage_paid_for_me: what each workspace paid for you, this month and last. */
export function parsePaidForMe(
  data: unknown,
  now: Date,
): Array<{ teamName: string } & MonthTotals> | undefined {
  const d = data as { ok?: unknown; rows?: unknown } | null;
  if (!d || d.ok !== true || !Array.isArray(d.rows) || d.rows.length === 0)
    return undefined;
  const months = monthKeys(now);
  const by = new Map<string, MonthTotals>();
  for (const r of d.rows as Array<Record<string, unknown>>) {
    if (r && typeof r.day === "string")
      addToMonth(
        by,
        text(r.team_name, "A Slack workspace"),
        r.day,
        cents(r.cents),
        months,
      );
  }
  const out = [...by]
    .map(([teamName, t]) => ({ teamName, ...t }))
    .filter((x) => x.thisMonthCents + x.lastMonthCents > 0);
  return out.length ? out : undefined;
}

let cached: { at: number; days: number; value: UsageCredits } | null = null;
let inFlight: Promise<UsageCredits> | null = null;

export async function getUsageCredits(
  days = 365,
  maxAgeMs = 60_000,
): Promise<UsageCredits> {
  if (cached && cached.days === days && Date.now() - cached.at <= maxAgeMs)
    return cached.value;
  inFlight ??= (async () => {
    try {
      if (!(await getSession().catch(() => null)))
        return { state: "signed_out" } as const;
      const now = new Date();
      const client = getSupabaseClient();
      const tz = localTimeZone();
      const teamDays = daysSinceLastMonthStart(now);
      // The team and paid-for-me parts are extra: either failing leaves the rest.
      const [credits, team, paid] = await Promise.all([
        client.rpc("get_usage_credits", { p_days: days, p_tz: tz }),
        Promise.resolve(
          client.rpc("get_usage_team", { p_days: teamDays, p_tz: tz }),
        ).catch(() => null),
        Promise.resolve(
          client.rpc("get_usage_paid_for_me", { p_days: teamDays, p_tz: tz }),
        ).catch(() => null),
      ]);
      let value: UsageCredits = credits.error
        ? { state: "unavailable" }
        : parseUsageCredits(credits.data);
      if (value.state === "ok") {
        const t =
          team && !team.error ? parseUsageTeam(team.data, now) : undefined;
        const p =
          paid && !paid.error ? parsePaidForMe(paid.data, now) : undefined;
        value = {
          ...value,
          ...(t ? { team: t } : {}),
          ...(p ? { paidForMe: p } : {}),
        };
      }
      cached = { at: Date.now(), days, value };
      return value;
    } catch {
      return { state: "unavailable" } as const;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
