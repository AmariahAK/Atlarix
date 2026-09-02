import { createRoute } from "@tanstack/react-router";
import { settingsRoute } from "@/routes/settings";
import { GeneralSettings } from "@/pages/settings";
import { useAppVersion } from "@/hooks/useAppVersion";

/**
 * The index is General. `appVersion` is fetched here rather than threaded from
 * the layout so the layout does not re-render on a value only this page shows.
 */
function GeneralSettingsPage() {
  const appVersion = useAppVersion();
  return <GeneralSettings appVersion={appVersion} />;
}

export const generalSettingsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/",
  component: GeneralSettingsPage,
});
