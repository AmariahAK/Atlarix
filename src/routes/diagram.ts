import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import DiagramPage from "../pages/diagram";
import { z } from "zod";

export const diagramRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/diagram",
    component: DiagramPage,
    validateSearch: z.object({
        appId: z.number().optional(),
    }),
});
