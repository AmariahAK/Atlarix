import { createRoute } from "@tanstack/react-router";
import { settingsRoute } from "@/routes/settings";
import { ComputerUseSettings } from "@/pages/settings";

export const computerUseSettingsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "computer-use",
  component: ComputerUseSettings,
});
