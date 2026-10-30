import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import { UsagePage } from "../pages/usage";

export const usageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/usage",
  component: UsagePage,
});
