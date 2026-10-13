/**
 * The time picker writes cron; cron stays the source of truth.
 *
 * The property that matters is the one a naive picker breaks: opening the dialog
 * on a hand-written schedule must not flatten it. an every-15-minutes cron has no time of
 * day, so the picker reports null and leaves the expression alone rather than
 * "helpfully" rewriting it to a single hour.
 */
import { describe, it, expect } from "vitest";
import {
  clockFromCron,
  cronWithClock,
  formatClock,
  HOUR_OPTIONS,
  MINUTE_OPTIONS,
  describeCron,
} from "@/lib/automations/cron-time";

describe("clockFromCron", () => {
  it("reads a plain time of day", () => {
    expect(clockFromCron("0 9 * * *")).toEqual({
      hour12: 9,
      minute: 0,
      meridiem: "AM",
    });
    expect(clockFromCron("30 14 * * *")).toEqual({
      hour12: 2,
      minute: 30,
      meridiem: "PM",
    });
  });

  it("gets both ends of the clock right", () => {
    // The two every-12-hour-cycle bugs: midnight is 12 AM, noon is 12 PM.
    expect(clockFromCron("0 0 * * *")).toEqual({
      hour12: 12,
      minute: 0,
      meridiem: "AM",
    });
    expect(clockFromCron("0 12 * * *")).toEqual({
      hour12: 12,
      minute: 0,
      meridiem: "PM",
    });
    expect(clockFromCron("59 23 * * *")?.meridiem).toBe("PM");
    expect(clockFromCron("59 23 * * *")?.hour12).toBe(11);
  });

  it("returns null for a cron with no single time — and that is the point", () => {
    // If these returned a time, opening the dialog would overwrite a working
    // schedule with whatever the picker happened to show.
    expect(clockFromCron("*/15 * * * *")).toBeNull();
    expect(clockFromCron("0 */2 * * *")).toBeNull();
    expect(clockFromCron("0 9-17 * * *")).toBeNull();
    expect(clockFromCron("0 9 * *")).toBeNull(); // too few fields
    expect(clockFromCron("")).toBeNull();
  });

  it("rejects out-of-range numbers rather than showing nonsense", () => {
    expect(clockFromCron("60 9 * * *")).toBeNull();
    expect(clockFromCron("0 24 * * *")).toBeNull();
  });
});

describe("cronWithClock", () => {
  it("writes the time and PRESERVES day/month/weekday", () => {
    // "Weekly on Monday" must stay weekly on Monday when you change the hour.
    expect(
      cronWithClock("0 9 * * 1", { hour12: 2, minute: 30, meridiem: "PM" }),
    ).toBe("30 14 * * 1");
    expect(
      cronWithClock("0 9 1 * *", { hour12: 6, minute: 5, meridiem: "AM" }),
    ).toBe("5 6 1 * *");
  });

  it("maps midnight and noon back correctly", () => {
    expect(
      cronWithClock("0 0 * * *", { hour12: 12, minute: 0, meridiem: "AM" }),
    ).toBe("0 0 * * *");
    expect(
      cronWithClock("0 0 * * *", { hour12: 12, minute: 0, meridiem: "PM" }),
    ).toBe("0 12 * * *");
  });

  it("round-trips through the clock without drift", () => {
    for (const cron of [
      "0 0 * * *",
      "30 14 * * 1",
      "7 9 * * *",
      "59 23 1 * *",
    ]) {
      const clock = clockFromCron(cron);
      expect(clock).not.toBeNull();
      expect(cronWithClock(cron, clock!)).toBe(cron);
    }
  });

  it("falls back to a daily schedule when the existing cron is unusable", () => {
    expect(
      cronWithClock("nonsense", { hour12: 9, minute: 0, meridiem: "AM" }),
    ).toBe("0 9 * * *");
  });
});

describe("picker options", () => {
  it("offers every minute, because the column scrolls", () => {
    // Coarsening to 5-minute steps exists to keep dropdowns short; a scrollable
    // column has no such constraint, and "at 9:07" is a real request.
    expect(MINUTE_OPTIONS).toHaveLength(60);
    expect(MINUTE_OPTIONS[0]).toBe(0);
    expect(MINUTE_OPTIONS[59]).toBe(59);
    expect(HOUR_OPTIONS).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("formats with a padded minute", () => {
    expect(formatClock({ hour12: 9, minute: 5, meridiem: "AM" })).toBe(
      "9:05 AM",
    );
    expect(formatClock({ hour12: 12, minute: 0, meridiem: "PM" })).toBe(
      "12:00 PM",
    );
  });
});

// QA (app) #22: the panel showed "cron 0 9 * * 1-5".
describe("describeCron", () => {
  it("says a simple schedule as a person would", () => {
    expect(describeCron("0 9 * * 1-5")).toBe("9:00 AM, Mon–Fri");
    expect(describeCron("30 14 * * *")).toBe("2:30 PM, every day");
  });
  it("leaves anything else to the cron line", () => {
    expect(describeCron("*/15 * * * *")).toBeNull();
    expect(describeCron("0 9 1 * *")).toBeNull();
  });
});
