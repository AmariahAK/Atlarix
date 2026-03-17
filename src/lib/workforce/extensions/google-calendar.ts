/**
 * Google Calendar — Workforce extension (Token Vault).
 * calendar.readonly
 */

import { createWorkforceExtension } from "../create-extension";

export const googleCalendarExtension = createWorkforceExtension(
  "Google Calendar",
  "google_calendar",
  ["https://www.googleapis.com/auth/calendar.readonly"]
);
