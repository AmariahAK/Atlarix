import { createRouter } from "@tanstack/react-router";
import { rootRoute } from "./routes/root";
import { homeRoute } from "./routes/home";
import { chatRoute } from "./routes/chat";
import { settingsRoute } from "./routes/settings";
import { providerSettingsRoute } from "./routes/settings/providers/$provider";
import { mcpSettingsRoute } from "./routes/settings/mcp";
import { skillsSettingsRoute } from "./routes/settings/skills";
import { appDetailsRoute } from "./routes/app-details";
import { codeRoute } from "./routes/code";
import { toolsRoute } from "./routes/tools";
import { signInRoute } from "./routes/sign-in";
import { accountSettingsRoute } from "./routes/account";

const routeTree = rootRoute.addChildren([
  homeRoute,
  codeRoute,
  toolsRoute,
  chatRoute,
  appDetailsRoute,
  signInRoute,
  accountSettingsRoute,
  settingsRoute.addChildren([providerSettingsRoute, mcpSettingsRoute, skillsSettingsRoute]),
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
