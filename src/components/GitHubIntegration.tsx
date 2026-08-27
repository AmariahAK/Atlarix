import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Github } from "lucide-react";
import { useSettings } from "@/hooks/useSettings";
import { IpcClient } from "@/ipc/ipc_client";
import { showSuccess, showError } from "@/lib/toast";

export function GitHubIntegration() {
  const { settings, updateSettings, refreshSettings } = useSettings();
  const [isDisconnecting, setIsDisconnecting] = useState(false);

  const handleDisconnectFromGithub = async () => {
    setIsDisconnecting(true);
    try {
      IpcClient.getInstance().cancelGithubDeviceFlow();
      const result = await updateSettings({
        githubAccessToken: undefined,
        githubUser: undefined,
      });
      await refreshSettings();
      if (result) {
        showSuccess("Disconnected from GitHub. Connect again to use another account.");
      } else {
        showError("Failed to disconnect from GitHub");
      }
    } catch (err: any) {
      showError(
        err.message || "An error occurred while disconnecting from GitHub",
      );
    } finally {
      setIsDisconnecting(false);
    }
  };

  const isConnected = !!settings?.githubAccessToken;

  /**
   * THE DISCONNECTED STATE IS NOT NOTHING.
   *
   * This returned `null`, while the settings page rendered a sentence about
   * disconnecting UNDERNEATH it, unconditionally. So anyone who had not connected
   * saw help text describing a button that was not on the screen.
   *
   * The sentence was also wrong in a way that outlasted the missing button: it
   * said "GitHub sign-in is saved on this Mac", conflating this with signing into
   * your Atlarix account using GitHub. They are unrelated credentials — you can be
   * signed in through GitHub OAuth and have no `githubAccessToken` at all, which
   * is exactly the state that produced the report.
   *
   * Settings can only DISCONNECT: the device-code flow is offered when you clone
   * a repository from GitHub (`WelcomeCloneDialog`), so the honest empty state
   * says where it comes from rather than offering a button that is not here.
   */
  if (!isConnected) {
    return (
      <div>
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
          GitHub Integration
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          Not connected. Atlarix asks for access when you clone a repository from GitHub, and
          saves it on this Mac from then on. This is separate from signing in to your Atlarix
          account with GitHub.
        </p>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between">
      <div>
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
          GitHub Integration
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          Connected, and saved on this Mac until you disconnect. Disconnect to use a different
          GitHub account.
        </p>
      </div>

      <Button
        onClick={handleDisconnectFromGithub}
        variant="destructive"
        size="sm"
        disabled={isDisconnecting}
        className="flex items-center gap-2"
      >
        {isDisconnecting ? "Disconnecting..." : "Disconnect from GitHub"}
        <Github className="h-4 w-4" />
      </Button>
    </div>
  );
}
