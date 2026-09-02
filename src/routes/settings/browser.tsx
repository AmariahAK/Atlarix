import { createRoute } from "@tanstack/react-router";
import { settingsRoute } from "@/routes/settings";
import { BrowserSettings } from "@/pages/settings";

export const browserSettingsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "browser",
  component: BrowserSettings,
});
