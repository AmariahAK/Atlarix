import { createRoute } from "@tanstack/react-router";
import { settingsRoute } from "@/routes/settings";
import { DangerZoneSettings } from "@/pages/settings";

export const dangerSettingsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "danger",
  component: DangerZoneSettings,
});
