import { showError } from "@/lib/toast";

/**
 * Open the native directory picker and return the chosen path.
 *
 * Cancel and failure are DIFFERENT outcomes and must stay that way: a user who
 * cancels chose nothing and should see nothing, while a picker that never opened
 * (the Linux case that dead-ended a v14.24.0 onboarding review) has to say so —
 * otherwise the caller's button looks broken with no explanation.
 *
 * Extracted from `useGithubCloneFlow.chooseFolder`, which coupled the same logic
 * to that hook's own input state. This copy has no side effects, so any caller
 * can use it.
 */
export async function chooseFolder(): Promise<string | null> {
  const bridge = window.electron?.ipcRenderer;
  if (!bridge) {
    showError(
      "Couldn't open the folder picker — type the folder path instead.",
    );
    return null;
  }
  try {
    const result = (await bridge.invoke("dialog:openDirectory")) as
      | { canceled?: boolean; filePaths?: string[] }
      | undefined;
    if (result?.canceled) return null; // deliberate: silent on cancel
    const picked = result?.filePaths?.[0];
    if (!picked) {
      showError(
        "Couldn't open the folder picker — type the folder path instead.",
      );
      return null;
    }
    return picked;
  } catch (e) {
    showError(
      `Couldn't open the folder picker — type the folder path instead. (${
        e instanceof Error ? e.message : String(e)
      })`,
    );
    return null;
  }
}
