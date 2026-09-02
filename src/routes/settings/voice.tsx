import { createRoute } from "@tanstack/react-router";
import { settingsRoute } from "@/routes/settings";
import { VoiceSettings } from "@/pages/settings";

export const voiceSettingsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "voice",
  component: VoiceSettings,
});
