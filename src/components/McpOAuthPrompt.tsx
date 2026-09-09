import { useEffect } from "react";
import { toast } from "sonner";
import { IpcClient } from "@/ipc/ipc_client";
import { Button } from "@/components/ui/button";
import { openSettingsSection } from "@/lib/open-settings-section";

function openMcpSettings(): void {
  openSettingsSection("mcp");
}

export function McpOAuthPrompt() {
  useEffect(() => {
    const ipc = IpcClient.getInstance();

    const offRedirect = ipc.onMcpOAuthRedirect(({ serverId, serverName }) => {
      toast(`Sign in to ${serverName}`, {
        id: `mcp-oauth-${serverId}`,
        description:
          "Complete sign-in in your browser, then return to Atlarix.",
        duration: 60_000,
        cancel: {
          label: "Cancel",
          onClick: () => {
            void ipc.cancelMcpOAuth(serverId);
          },
        },
      });
    });

    const offSuccess = ipc.onMcpOAuthSuccess(({ serverId, serverName }) => {
      toast.dismiss(`mcp-oauth-${serverId}`);
      toast.success(`Connected to ${serverName}`);
    });

    const offError = ipc.onMcpOAuthError(({ serverId, serverName, error }) => {
      toast.dismiss(`mcp-oauth-${serverId}`);
      toast.error(`Could not connect to ${serverName}`, { description: error });
    });

    const offRequired = ipc.onMcpOAuthRequired(({ serverId }) => {
      toast("MCP sign-in required", {
        id: `mcp-oauth-required-${serverId}`,
        description: "Open Settings → MCP to connect this server.",
        action: {
          label: "Connect",
          onClick: () => {
            void ipc.startMcpOAuth({ serverId }).catch((e) => {
              toast.error(e instanceof Error ? e.message : String(e));
            });
          },
        },
      });
    });

    // Non-OAuth (API key / env) servers the agent tried to use without credentials.
    const offAuthRequired = ipc.onMcpAuthRequired(
      ({ serverId, serverName, reason }) => {
        const verb =
          reason === "invalid"
            ? "re-enter the credentials"
            : "add the credentials";
        toast(`Configure ${serverName}`, {
          id: `mcp-auth-${serverId}`,
          description: `This MCP server needs credentials — ${verb} in Settings → MCP, then the agent will retry.`,
          duration: 120_000,
          action: {
            label: "Open settings",
            onClick: openMcpSettings,
          },
        });
      },
    );

    return () => {
      offRedirect();
      offSuccess();
      offError();
      offRequired();
      offAuthRequired();
    };
  }, []);

  return null;
}

/** Inline OAuth controls for a server row in MCP settings. */
export function McpOAuthServerActions({
  serverId,
  serverName,
  oauthConnected,
  onChanged,
}: {
  serverId: number;
  serverName: string;
  oauthConnected?: boolean;
  onChanged?: () => void;
}) {
  const ipc = IpcClient.getInstance();

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">
        {oauthConnected ? "OAuth connected" : "Sign-in required"}
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          void ipc
            .startMcpOAuth({ serverId })
            .then(() => onChanged?.())
            .catch((e) =>
              toast.error(e instanceof Error ? e.message : String(e)),
            );
        }}
      >
        {oauthConnected ? "Reconnect" : "Connect"}
      </Button>
      {oauthConnected ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void ipc
              .revokeMcpOAuth(serverId)
              .then(() => {
                toast.success(`Disconnected ${serverName}`);
                onChanged?.();
              })
              .catch((e) =>
                toast.error(e instanceof Error ? e.message : String(e)),
              );
          }}
        >
          Disconnect
        </Button>
      ) : null}
    </div>
  );
}
