import { createRoute } from "@tanstack/react-router";
import { settingsRoute } from "@/routes/settings";
import { DiagnosticsSection } from "@/pages/settings";

export const diagnosticsSettingsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "diagnostics",
  component: DiagnosticsSection,
});
