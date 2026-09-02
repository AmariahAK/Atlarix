import { createRoute } from "@tanstack/react-router";
import { z } from "zod";
import { integrationsRoute } from "@/routes/integrations";
import { McpSettingsPage } from "@/components/settings/McpSettingsPage";

export const integrationsMcpRoute = createRoute({
  getParentRoute: () => integrationsRoute,
  path: "mcp",
  component: McpSettingsPage,
  validateSearch: z.object({
    // First-run wizard deep-links straight to the marketplace tab.
    tab: z.enum(["active", "marketplace"]).optional(),
  }),
});
