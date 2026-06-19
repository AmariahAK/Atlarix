import { readSettings, writeSettings } from "./settings";
import { trackModelConnected } from "./lib/analytics";

export function handleAtlarixProReturn({ apiKey }: { apiKey: string }) {
  const settings = readSettings();
  writeSettings({
    providerSettings: {
      ...settings.providerSettings,
      auto: {
        ...settings.providerSettings.auto,
        apiKey: {
          value: apiKey,
        },
      },
    },
    enableAtlarixPro: true,
  });
  // Funnel: the managed Core model is now wired up.
  trackModelConnected({ type: "core" });
}
