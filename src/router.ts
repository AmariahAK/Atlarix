import { createRouter } from "@tanstack/react-router";
import { rootRoute } from "./routes/root";
import { homeRoute } from "./routes/home";
import { settingsRoute } from "./routes/settings";
import { generalSettingsRoute } from "./routes/settings/index";
import { diagnosticsSettingsRoute } from "./routes/settings/diagnostics";
import { browserSettingsRoute } from "./routes/settings/browser";
import { searchSettingsRoute } from "./routes/settings/search";
import { notificationsSettingsRoute } from "./routes/settings/notifications";
import { voiceSettingsRoute } from "./routes/settings/voice";
import { computerUseSettingsRoute } from "./routes/settings/computer-use";
import { dangerSettingsRoute } from "./routes/settings/danger";
import { providerSettingsRoute } from "./routes/integrations/providers/$provider";
import { integrationsRoute } from "./routes/integrations";
import { integrationsProvidersRoute } from "./routes/integrations/index";
import { integrationsMcpRoute } from "./routes/integrations/mcp";
import { integrationsSkillsRoute } from "./routes/integrations/skills";
import { integrationsPluginsRoute } from "./routes/integrations/plugins";
import { integrationsCoAuthorRoute } from "./routes/integrations/co-author";
import { integrationsPermissionsRoute } from "./routes/integrations/permissions";
import { toolsRoute } from "./routes/tools";
import { signInRoute } from "./routes/sign-in";
import { accountSettingsRoute } from "./routes/account";
import { usageRoute } from "./routes/usage";

const routeTree = rootRoute.addChildren([
  homeRoute,
  toolsRoute,
  signInRoute,
  accountSettingsRoute,
  usageRoute,
  // Preferences. One section per child route — see pages/settings.tsx.
  settingsRoute.addChildren([
    generalSettingsRoute,
    diagnosticsSettingsRoute,
    browserSettingsRoute,
    searchSettingsRoute,
    notificationsSettingsRoute,
    voiceSettingsRoute,
    computerUseSettingsRoute,
    dangerSettingsRoute,
  ]),
  // Everything Atlarix connects TO. Split from /settings by KIND, not scope:
  // model providers, MCP, Skills, commit attribution and per-project
  // permissions are connections and policy; appearance, voice and
  // notifications are preferences.
  integrationsRoute.addChildren([
    integrationsProvidersRoute,
    providerSettingsRoute,
    integrationsMcpRoute,
    integrationsSkillsRoute,
    integrationsPluginsRoute,
    integrationsCoAuthorRoute,
    integrationsPermissionsRoute,
  ]),
]);

// src/components/NotFoundRedirect.tsx
import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { ErrorBoundary } from "./components/ErrorBoundary";

export function NotFoundRedirect() {
  const navigate = useNavigate();

  React.useEffect(() => {
    // Navigate to the main route ('/') immediately on mount
    // 'replace: true' prevents the invalid URL from being added to browser history
    navigate({ to: "/", replace: true });
  }, [navigate]); // Dependency array ensures this runs only once

  // Optionally render null or a loading indicator while redirecting
  // The redirect is usually very fast, so null is often fine.
  return null;
  // Or: return <div>Redirecting...</div>;
}

export const router = createRouter({
  routeTree,
  defaultNotFoundComponent: NotFoundRedirect,
  defaultErrorComponent: ErrorBoundary,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
