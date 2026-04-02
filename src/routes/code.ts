import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import CodePage from "../pages/code";
import { z } from "zod";

export const codeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/code",
  component: CodePage,
  validateSearch: z.object({
    appId: z.number().optional(),
    /** Fix: Finding 2 — open full-screen code page with this file in the editor */
    file: z.string().optional(),
    tab: z.enum(["chat", "errors", "terminal"]).optional(),
  }),
});
