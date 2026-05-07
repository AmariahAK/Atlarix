import { createRoute } from "@tanstack/react-router";
import { settingsRoute } from "@/routes/settings";
import { SkillsSettingsPage } from "@/components/settings/SkillsSettingsPage";

export const skillsSettingsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "skills",
  component: SkillsSettingsPage,
});

