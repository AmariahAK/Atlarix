import { createRoute } from "@tanstack/react-router";
import { settingsRoute } from "@/routes/settings";
import { CommunitySection } from "@/pages/settings";

export const communitySettingsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "community",
  component: CommunitySection,
});
