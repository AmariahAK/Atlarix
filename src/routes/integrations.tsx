import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import { IntegrationsLayout } from "@/pages/integrations";

/**
 * Everything Atlarix connects TO, and what it may do there. Split from Settings
 * by KIND rather than scope — see the note in pages/integrations.tsx.
 */
export const integrationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/integrations",
  component: IntegrationsLayout,
});
