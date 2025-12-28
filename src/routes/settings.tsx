import { createRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { rootRoute } from "./root";
import SettingsPage from "../pages/settings";

// Settings layout that renders Outlet for child routes or SettingsPage for main
function SettingsLayout() {
  const routerState = useRouterState();
  const location = routerState.location;

  // Check if we're on a child route (path has more than just /settings)
  const isChildRoute = location.pathname.startsWith('/settings/') && location.pathname !== '/settings/';

  if (isChildRoute) {
    return <Outlet />;
  }

  return <SettingsPage />;
}

export const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsLayout,
});
