/**
 * Opening the upgrade checkout.
 *
 * Opens LemonSqueezy with the user's email prefilled, and surfaces a toast if they
 * are not signed in.
 *
 * THERE USED TO BE A `useUpgrade` HOOK HERE TOO, and it was this same function
 * wrapped in `useCallback` plus an `isLoading` flag. Its only consumer was the
 * free-tier MCP gate in `ToolsMcpSettings.tsx`, which never read `isLoading` and
 * which was deleted when the app became free — Pro no longer sells unlimited MCP,
 * so the gate was advertising a benefit that does not exist. With that gone the hook
 * had no callers and was a second copy of the body below, so it went with it.
 *
 * The filename is kept as-is deliberately: renaming it would touch every import for
 * no behavioural gain.
 */

import { showError } from "@/lib/toast";

interface UpgradeResult {
  success: boolean;
  error?: string;
  message?: string;
}

/** Callable from anywhere — event handlers included, since it is not a hook. */
export async function triggerUpgrade(): Promise<UpgradeResult> {
  try {
    const ipcRenderer = window.electron?.ipcRenderer;
    if (!ipcRenderer?.invoke) {
      const error = "Unable to access upgrade. Please restart the app.";
      showError(error);
      return { success: false, error };
    }

    const result = (await ipcRenderer.invoke("auth:upgrade")) as UpgradeResult;

    if (!result.success && result.error) {
      // User needs to sign in first - show toast
      showError(result.error);
    }

    return result;
  } catch {
    const errorMessage = "Failed to open upgrade page. Please try again.";
    showError(errorMessage);
    return { success: false, error: errorMessage };
  }
}
