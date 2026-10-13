/**
 * The clock half of a cron expression.
 *
 * The editor was four presets plus a raw cron box, so "every day at 2:30 pm"
 * meant knowing that `30 14 * * *` puts minutes first. A picker covers the case
 * people actually want — a time of day — without becoming a ceiling: the CRON
 * STRING REMAINS THE SOURCE OF TRUTH and the picker only writes into it. Anything
 * cron can express (step syntax like every-N-minutes, ranges) still works, and the picker
 * simply reports that it cannot show it rather than overwriting it.
 *
 * That direction matters. A picker that owned the value would silently flatten a
 * hand-written every-2-hours expression into a single hour the moment the dialog opened.
 */

/** 5-field cron: minute hour dom month dow. */
export type ClockTime = {
  /** 1-12 as displayed. */
  hour12: number;
  minute: number;
  meridiem: "AM" | "PM";
};

/**
 * The time a cron fires, or null when it does not describe a single one.
 *
 * Null is a real answer, not a failure: an every-15-minutes cron has no time of day, and
 * pretending otherwise is how the picker would destroy it.
 */
export function clockFromCron(cron: string): ClockTime | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour] = parts;
  if (!/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hour)) return null;

  const minute = Number(min);
  const hour24 = Number(hour);
  if (minute > 59 || hour24 > 23) return null;

  return {
    hour12: hour24 % 12 === 0 ? 12 : hour24 % 12,
    minute,
    meridiem: hour24 < 12 ? "AM" : "PM",
  };
}

/** Write a time into a cron, preserving its day/month/weekday fields. */
export function cronWithClock(cron: string, time: ClockTime): string {
  const parts = cron.trim().split(/\s+/);
  const rest = parts.length === 5 ? parts.slice(2) : ["*", "*", "*"];
  const hour24 =
    time.meridiem === "AM" ? time.hour12 % 12 : (time.hour12 % 12) + 12;
  return [String(time.minute), String(hour24), ...rest].join(" ");
}

/** 1-12, for the hour column. */
export const HOUR_OPTIONS: number[] = Array.from(
  { length: 12 },
  (_, i) => i + 1,
);

/**
 * Every minute, 0-59.
 *
 * All sixty rather than a 5-minute step because the column scrolls — the reason
 * to coarsen a picker is to keep a dropdown short, and a scrollable column has
 * no such limit. "Run it at 9:07" is a legitimate thing to want.
 */
export const MINUTE_OPTIONS: number[] = Array.from({ length: 60 }, (_, i) => i);

export function formatClock(time: ClockTime): string {
  return `${time.hour12}:${String(time.minute).padStart(2, "0")} ${time.meridiem}`;
}

const DAY_WORDS: Record<string, string> = {
  "*": "every day",
  "1-5": "Mon–Fri",
  "0,6": "weekends",
  "6,0": "weekends",
  "1": "Mondays",
  "0": "Sundays",
  "5": "Fridays",
};

/**
 * "0 9 * * 1-5" → "9:00 AM, Mon–Fri", as a person says it, the way the CLI's
 * approval does; null when it isn't a simple time of day (the cron line is
 * the honest label then). The app showed "cron 0 9 * * 1-5" (QA #22).
 */
export function describeCron(cron: string): string | null {
  const f = cron.trim().split(/\s+/);
  const time = clockFromCron(cron);
  if (!time || f[2] !== "*" || f[3] !== "*") return null;
  return `${formatClock(time)}, ${DAY_WORDS[f[4]!] ?? `weekdays ${f[4]}`}`;
}
