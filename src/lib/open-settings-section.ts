import { router } from "@/router";

/**
 * Open the surface that owns `sectionId` and scroll to it.
 *
 * WHY THERE IS A MAP NOW
 * ----------------------
 * This used to hardcode `navigate({ to: "/settings" })`, which was fine while
 * every section lived on that one page. Connections and policy (model
 * providers, MCP, Skills, commit attribution, per-project permissions) moved to
 * `/integrations`, so a section id no longer implies a route.
 *
 * The map lives HERE rather than at each call site deliberately: all three
 * callers are error affordances — an MCP OAuth prompt, a failed MCP tool call,
 * and the chat error box offering to fix a model problem. They are reached by
 * someone who is ALREADY STUCK, so a link that lands on the wrong page is worse
 * than average, and a second mechanism for routing them is one more thing to
 * forget to update.
 *
 * Anything unmapped falls through to `/settings`. There is no scroll target any
 * more: both pages are one-section-per-route, so navigating IS arriving.
 */

/**
 * Section ids whose controls live on the Integrations page.
 *
 * `ai` is here because a model error is the most common reason anything calls
 * this: `ChatErrorBox` offers "open settings" when a provider call fails, and
 * the provider grid is the Integrations index now.
 */
const INTEGRATION_SECTIONS: Record<
  string,
  | "/integrations"
  | "/integrations/mcp"
  | "/integrations/skills"
  | "/integrations/co-author"
  | "/integrations/permissions"
> = {
  ai: "/integrations",
  models: "/integrations",
  providers: "/integrations",
  mcp: "/integrations/mcp",
  skills: "/integrations/skills",
  // `github` kept as an alias: nothing calls it today, but the section was
  // named that until the GitHub token went, and a stale caller landing on
  // /settings would be worse than landing on the page that absorbed it.
  github: "/integrations/co-author",
  "co-author": "/integrations/co-author",
  workflow: "/integrations/permissions",
  permissions: "/integrations/permissions",
};

export function openSettingsSection(sectionId: string): void {
  const integrationRoute = INTEGRATION_SECTIONS[sectionId];
  if (integrationRoute) {
    // These routes ARE the section — there is nothing to scroll to, so the
    // one-shot scroll target is deliberately not set.
    void router.navigate({ to: integrationRoute });
    return;
  }

  // Unmapped: land on Settings. The one-shot scroll atom this used to set is
  // gone with the scroll-spy — sections are routes, so there is nothing to
  // scroll to and nothing to race against the page mount.
  void router.navigate({ to: "/settings" });
}
