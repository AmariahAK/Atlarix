import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import { AccountSettings } from "../pages/account-settings";

export const accountSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/account",
  component: AccountSettings,
});
