import { createRoute } from "@tanstack/react-router";
import { settingsRoute } from "@/routes/settings";
import { SearchSettingsSection } from "@/pages/settings";

export const searchSettingsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "search",
  component: SearchSettingsSection,
});
