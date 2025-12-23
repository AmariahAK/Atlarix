import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import AtlarixHome from "../pages/atlarix-home";
import { z } from "zod";

export const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: AtlarixHome,
  validateSearch: z.object({
    appId: z.number().optional(),
  }),
});
