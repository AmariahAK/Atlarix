import { createRoute } from "@tanstack/react-router";
import { integrationsRoute } from "@/routes/integrations";
import { PluginsSettingsPage } from "@/components/settings/PluginsSettingsPage";

export const integrationsPluginsRoute = createRoute({
  getParentRoute: () => integrationsRoute,
  path: "plugins",
  component: PluginsSettingsPage,
});
