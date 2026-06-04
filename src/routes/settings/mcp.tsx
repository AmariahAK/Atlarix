import { createRoute } from "@tanstack/react-router";
import { z } from "zod";
import { settingsRoute } from "@/routes/settings";
import { McpSettingsPage } from "@/components/settings/McpSettingsPage";

export const mcpSettingsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "mcp",
  component: McpSettingsPage,
  validateSearch: z.object({
    // First-run wizard deep-links straight to the marketplace tab.
    tab: z.enum(["active", "marketplace"]).optional(),
  }),
});
