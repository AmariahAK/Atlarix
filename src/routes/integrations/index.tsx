import { createRoute } from "@tanstack/react-router";
import { integrationsRoute } from "@/routes/integrations";
import { IntegrationsProvidersPage } from "@/pages/integrations-providers";

/** The index is Models & providers: the most common reason to open this page. */
export const integrationsProvidersRoute = createRoute({
  getParentRoute: () => integrationsRoute,
  path: "/",
  component: IntegrationsProvidersPage,
});
