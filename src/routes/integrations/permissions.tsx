import { createRoute } from "@tanstack/react-router";
import { integrationsRoute } from "@/routes/integrations";
import { IntegrationsPermissionsPage } from "@/pages/integrations-permissions";

export const integrationsPermissionsRoute = createRoute({
  getParentRoute: () => integrationsRoute,
  path: "permissions",
  component: IntegrationsPermissionsPage,
});
