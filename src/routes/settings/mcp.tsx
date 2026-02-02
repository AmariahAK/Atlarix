import { createRoute } from "@tanstack/react-router";
import { settingsRoute } from "@/routes/settings";
import { McpSettingsPage } from "@/components/settings/McpSettingsPage";

export const mcpSettingsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "mcp",
  component: McpSettingsPage,
});
