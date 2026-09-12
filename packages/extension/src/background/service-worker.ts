/**
 * The MV3 service worker — the extension's only always-addressable context.
 *
 * WHAT IT IS NOT. It is not where work lives. Chrome terminates this worker
 * after roughly 30 seconds idle, and nothing here may assume it survives
 * between two events. That single fact decides most of the extension's shape:
 *
 *   - No refresh TIMER for the Supabase session. A timer scheduled here is
 *     killed with the worker and the token quietly rots. Refresh happens on
 *     demand instead, checked against `exp` before each call.
 *   - No sign-in. `launchWebAuthFlow` holds a promise open for as long as the
 *     user looks at a consent screen, which is routinely longer than the worker
 *     lives. Sign-in runs in the side panel, which is an ordinary document with
 *     an ordinary lifetime.
 *   - No agent loop. That lands in the offscreen document, for the same reason.
 *
 * What DOES belong here is exactly what must be addressable from anywhere and
 * owned by one context: the single-flight token refresh (Supabase rotates
 * refresh tokens, so two concurrent refreshes race and the loser's
 * `400 invalid_grant` presents to the user as a spontaneous logout), and the
 * message router other contexts ask through.
 */

import { api } from "../shared/browser-api";

/**
 * Clicking the toolbar icon opens the side panel.
 *
 * This is why `action` in the manifest has no `default_popup`: a popup would
 * consume the click and the side panel would never open. Called at top level
 * rather than in `onInstalled`, because the worker is re-created after every
 * termination and the behaviour has to be re-registered each time.
 */
api()
  .sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err: unknown) => {
    // Firefox has `sidebarAction`, not `sidePanel`, and a port would reach this
    // line before `browser-api.ts`'s capability probe could degrade it. Log
    // rather than throw: an unhandled rejection at worker top level is reported
    // as a broken extension.
    console.error("[atlarix] sidePanel.setPanelBehavior failed", err);
  });
