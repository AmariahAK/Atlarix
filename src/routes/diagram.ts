import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import DiagramPage from "../pages/diagram";

export const diagramRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/diagram",
    component: DiagramPage,
});
