import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import ToolsPage from "../pages/tools";

export const toolsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tools",
  component: ToolsPage,
});
