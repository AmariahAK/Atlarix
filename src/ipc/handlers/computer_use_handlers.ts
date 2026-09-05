/**
 * Computer-use permission IPC.
 *
 * THE INTERESTING PART IS THE SHAPE OF `request`: it takes a KEY (`"accessibility"`
 * | `"screenRecording"`), never a URL.
 *
 * The macOS System Settings deep links are custom-scheme URLs
 * (`x-apple.systempreferences:…`), and `validateOpenExternalUrl`
 * (`src/lib/external_url.ts`) permits only `mailto:`, `http://` and `https://` —
 * it throws on anything else. The tempting fix is to widen that validator to admit
 * one more scheme, and it is the wrong one: it turns a narrow, auditable allowlist
 * into a general one, and the renderer could then ask main to open arbitrary URL
 * schemes. Taking a key instead means the renderer can name a PANE and cannot name
 * a DESTINATION, and the set of panes is fixed in main where it can be read.
 */

import log from "electron-log";
import { createLoggedHandler } from "./safe_handle";
import {
  readPermissions,
  relaunchForPermissions,
  requestPermission,
  type PaneKey,
} from "../../main/computer-use-permissions";

const logger = log.scope("computer_use_handlers");
const handle = createLoggedHandler(logger);

const PANES: PaneKey[] = ["accessibility", "screenRecording"];

export function registerComputerUseHandlers(): void {
  // Read-only and non-prompting — `isTrustedAccessibilityClient(false)` and
  // `getMediaAccessStatus`. Safe to call on mount, which is why the settings panel
  // does exactly that and nothing else.
  handle("computer-use:permissions", async () => readPermissions());

  // `createLoggedHandler` passes the raw IpcMainInvokeEvent first, like ipcMain
  // does; the payload is the second argument.
  handle("computer-use:request-permission", async (_event, payload: { which?: string }) => {
    const which = payload?.which ?? "";
    // Validate against the closed set rather than trusting the renderer: this is
    // the call that can open a system pane and provoke a prompt.
    if (!PANES.includes(which as PaneKey)) {
      throw new Error(`Unknown permission "${which}"`);
    }
    return await requestPermission(which as PaneKey);
  });

  // macOS caches the screen-capture decision per process, so a grant made while
  // the app is running only takes effect after a restart. Telling the user
  // "granted, now restart" and then doing it for them is the difference between
  // the feature working and "I granted it and nothing happened".
  handle("computer-use:relaunch", async () => {
    relaunchForPermissions();
    return { ok: true };
  });
}
