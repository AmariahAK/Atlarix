import { ShieldAlert, LogIn, KeyRound } from "lucide-react";
import type { ToolExpandView } from "@/lib/chat/tool-expand-view";
import { IpcClient } from "@/ipc/ipc_client";
import { openSettingsSection } from "@/lib/open-settings-section";

export function ToolMcpAuthExpand({
  view,
}: {
  view: Extract<ToolExpandView, { kind: "mcp_auth" }>;
}) {
  const isOAuth = view.authType === "oauth";

  const onAction = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isOAuth) {
      void IpcClient.getInstance().startMcpOAuth({ serverId: view.serverId });
    } else {
      openSettingsSection("mcp");
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-500">
        <ShieldAlert className="h-3.5 w-3.5 shrink-0 mt-px" />
        <span className="text-foreground/85">{view.message}</span>
      </div>
      <button
        type="button"
        onClick={onAction}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1 text-[11px] font-medium text-foreground hover:bg-muted transition-colors"
      >
        {isOAuth ? (
          <>
            <LogIn className="h-3.5 w-3.5" />
            Sign in to {view.serverName}
          </>
        ) : (
          <>
            <KeyRound className="h-3.5 w-3.5" />
            Configure {view.serverName}
          </>
        )}
      </button>
    </div>
  );
}
