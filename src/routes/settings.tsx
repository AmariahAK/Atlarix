import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import { SettingsLayout } from "@/pages/settings";

/**
 * Preferences only — how the app behaves for you.
 *
 * Each section is a CHILD ROUTE rather than an anchor on a long scroll (see the
 * note in pages/settings.tsx): the router answers "which section am I on?", so
 * the ~60 lines of scroll-spy geometry that used to answer it are gone, and a
 * wrong path is a compile error instead of a link that silently does nothing.
 */
export const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsLayout,
});
