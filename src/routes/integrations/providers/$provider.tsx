import { createRoute } from "@tanstack/react-router";

/**
 * A single provider's page (keys, models, token budget).
 *
 * Moved under /integrations with the provider grid that links to it — it used to
 * live at /settings/providers/$provider while the grid had already moved, so
 * clicking a provider jumped you out of Integrations and lit up Settings in the
 * sidebar.
 */
import { integrationsRoute } from "@/routes/integrations";
import { ProviderSettingsPage } from "@/components/settings/ProviderSettingsPage";

interface ProviderSettingsParams {
  provider: string;
}

export const providerSettingsRoute = createRoute({
  getParentRoute: () => integrationsRoute,
  path: "providers/$provider",
  params: {
    parse: (params: { provider: string }): ProviderSettingsParams => ({
      provider: params.provider,
    }),
  },
  component: function ProviderSettingsRouteComponent() {
    const { provider } = providerSettingsRoute.useParams();

    return <ProviderSettingsPage provider={provider} />;
  },
});
