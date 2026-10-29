/**
 * The Usage page's shapes, with no imports that reach the database or the
 * network, so a webview (VS Code) and the renderer can type against them.
 */

export type CalendarLevel = 0 | 1 | 2 | 3 | 4;

export type ActivitySurface = "app" | "cli" | "editor";

export interface ActivityDay {
  day: string;
  turns: number;
  level: CalendarLevel;
  /** False for cells padding the first week: drawn blank, not as a zero day. */
  inRange: boolean;
}

export interface ActivityStats {
  /** The first day with any activity, or null for none yet. */
  since: string | null;
  /** The first day tokens, models and tools were recorded (this release). */
  recordedSince: string | null;
  lifetimeTokens: number;
  peakDay: { day: string; tokens: number } | null;
  longestChat: { title: string; minutes: number } | null;
  currentStreak: number;
  longestStreak: number;
  totalChats: number;
  totalTurns: number;
  /** The last 53 weeks, a column per week Sunday→Saturday, oldest first. */
  weeks: ActivityDay[][];
  /** A month name over the week it starts in, else null. */
  monthLabels: (string | null)[];
  models: Array<{
    provider: string;
    modelId: string;
    turns: number;
    share: number;
  }>;
  modes: Array<{ mode: string; share: number }>;
  deepShare: number;
  surfaces: Array<{ surface: ActivitySurface; turns: number }>;
  /** Editor turns by the editor's own name (ACP `clientInfo`), from 0082 on. */
  editors: Array<{ editor: string; turns: number }>;
  skills: Array<{ name: string; runs: number }>;
  mcp: Array<{ name: string; runs: number }>;
  linesWritten: number;
  asOf: string;
}

export interface UsageFilters {
  days?: number;
  /** `provider\u0000modelId`, as `filters.models[].key`. */
  model?: string;
  /** app | cli | an editor's name | editor, as `filters.surfaces[].key`. */
  surface?: string;
  source?: string;
}

export interface UsageOption {
  key: string;
  label: string;
}

export interface UsageReport {
  overview: ActivityStats;
  range: number;
  /** The window, oldest first, one local day each. */
  days: string[];
  filters: {
    models: UsageOption[];
    surfaces: UsageOption[];
    sources: UsageOption[];
    applied: {
      model: string | null;
      surface: string | null;
      source: string | null;
    };
  };
  tokens: {
    /** Up to five models, then "Other". */
    series: UsageOption[];
    /** `values[i]` is `series[i]`'s tokens that day. */
    byDay: Array<{ day: string; values: number[] }>;
    total: number;
    /** The first day tokens were recorded, or null. */
    since: string | null;
  };
  tools: {
    byDay: Array<{ day: string; mcp: number; skill: number }>;
    mcp: Array<{ name: string; runs: number }>;
    skills: Array<{ name: string; runs: number }>;
  };
  autoPicks: {
    steps: number;
    models: Array<{
      label: string;
      billing: "free" | "paid";
      tier: string;
      steps: number;
      share: number;
    }>;
    byDay: Array<{ day: string; free: number; paid: number }>;
    since: string | null;
  };
  /** BYOK only, at list price; null until a priced BYOK turn exists. */
  byok: {
    totalUsd: number;
    byDay: Array<{ day: string; usd: number }>;
    pricedTurns: number;
    unpricedTurns: number;
    since: string;
  } | null;
}

export interface UsageCreditsDay {
  day: string;
  autoPaidCents: number;
  coreCents: number;
  /** Web search and transcription. */
  toolCents: number;
  /** Reviewer and cloud agent runs. */
  otherCents: number;
  /** Spend from before debits said what they were for. */
  unsplitCents: number;
}

export type UsageCredits =
  | { state: "signed_out" }
  /** The account server doesn't offer this yet (an older backend), or it failed. */
  | { state: "unavailable" }
  | {
      state: "ok";
      balanceCents: number;
      purchasedCents: number;
      /** Pro's allowance: left this period, and what the period granted. */
      grantedCents: number;
      grantedTotalCents: number;
      plan: "free" | "pro";
      renewsAt: string | null;
      since: string | null;
      days: UsageCreditsDay[];
    };
