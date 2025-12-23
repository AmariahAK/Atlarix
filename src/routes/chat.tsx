import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import AtlarixChat from "../pages/atlarix-chat";
import { z } from "zod";

export const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chat",
  component: AtlarixChat,
  validateSearch: z.object({
    id: z.number().optional(),
  }),
});
