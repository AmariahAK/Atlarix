import { createRoute } from "@tanstack/react-router";
import { settingsRoute } from "@/routes/settings";
import { NotificationsSettings } from "@/pages/settings";

export const notificationsSettingsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "notifications",
  component: NotificationsSettings,
});
