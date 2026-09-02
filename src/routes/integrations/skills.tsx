import { createRoute } from "@tanstack/react-router";
import { integrationsRoute } from "@/routes/integrations";
import { SkillsSettingsPage } from "@/components/settings/SkillsSettingsPage";

export const integrationsSkillsRoute = createRoute({
  getParentRoute: () => integrationsRoute,
  path: "skills",
  component: SkillsSettingsPage,
});
