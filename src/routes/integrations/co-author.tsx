import { createRoute } from "@tanstack/react-router";
import { integrationsRoute } from "@/routes/integrations";
import { IntegrationsCoAuthorPage } from "@/pages/integrations-co-author";

export const integrationsCoAuthorRoute = createRoute({
  getParentRoute: () => integrationsRoute,
  path: "co-author",
  component: IntegrationsCoAuthorPage,
});
