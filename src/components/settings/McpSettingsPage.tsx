/**
 * MCP Settings Page - Library-like UI (Global vs Workspace)
 * =========================================================
 * - Global MCP: 5 max, used in all chats
 * - Workspace MCP: 5 max per workspace, used when that workspace is active
 * Workspaces are read the same way as Library (listWorkspacesWithPromptStatus).
 */

import React, { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Globe, Folder } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { ToolsMcpSettings } from "./ToolsMcpSettings";
import { IpcClient } from "@/ipc/ipc_client";
import { ScrollArea } from "@/components/ui/scroll-area";

const MAX_GLOBAL_MCP = 5;
const MAX_WORKSPACE_MCP = 5;

interface WorkspaceWithStatus {
  id: number;
  name: string;
  path: string;
  hasPrompt: boolean;
  promptContent?: string;
}

function WorkspaceMcpCard({
  workspace,
  maxServers,
}: {
  workspace: WorkspaceWithStatus;
  maxServers: number;
}) {
  return (
    <div className="rounded-lg border border-border bg-card/50 p-4">
      <div className="flex items-center gap-3 min-w-0 mb-3">
        <Folder className="w-5 h-5 text-muted-foreground flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-medium truncate">{workspace.name}</div>
          <div className="text-xs text-muted-foreground truncate">{workspace.path}</div>
        </div>
      </div>
      <ToolsMcpSettings
        scope="workspace"
        appId={workspace.id}
        maxServers={maxServers}
      />
    </div>
  );
}

export function McpSettingsPage() {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<WorkspaceWithStatus[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(true);

  const loadWorkspaces = useCallback(async () => {
    try {
      setWorkspacesLoading(true);
      const result = await IpcClient.getInstance().listWorkspacesWithPromptStatus();
      setWorkspaces(result);
    } catch (error) {
      console.error("Failed to load workspaces for MCP:", error);
    } finally {
      setWorkspacesLoading(false);
    }
  }, []);

  useEffect(() => {
    loadWorkspaces();
  }, [loadWorkspaces]);

  return (
    <div className="flex-1 bg-background overflow-auto">
      <div className="max-w-4xl mx-auto px-8 py-6 pb-20 space-y-8">
        <Button
          onClick={() => router.navigate({ to: "/settings" })}
          variant="outline"
          size="sm"
          className="mb-4 bg-(--background-lightest) py-5"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Settings
        </Button>

        <div>
          <h1 className="text-3xl font-bold text-foreground">MCP Servers</h1>
          <p className="text-muted-foreground mt-1">
            Add and categorize MCP servers. Use <code className="text-xs bg-muted px-1 rounded">@mcp name</code> in chat to call a server.
          </p>
        </div>

        {/* Global MCP */}
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Globe className="w-5 h-5 text-primary" />
            <h2 className="text-xl font-semibold text-foreground">Global MCP</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            Available in every chat (incognito and workspace). Max {MAX_GLOBAL_MCP} servers.
          </p>
          <div className="bg-card rounded-xl shadow-sm p-6 border border-border">
            <ToolsMcpSettings maxServers={MAX_GLOBAL_MCP} scope="global" />
          </div>
        </div>

        <hr className="border-border" />

        {/* Workspace MCP - same workspace list as Library */}
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Folder className="w-5 h-5 text-primary" />
            <h2 className="text-xl font-semibold text-foreground">Workspace MCP</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            Project-specific servers, used only when that workspace is active in chat. Max {MAX_WORKSPACE_MCP} per workspace.
          </p>
          <div className="bg-card rounded-xl shadow-sm p-6 border border-border">
            {workspacesLoading ? (
              <p className="text-sm text-muted-foreground">Loading workspaces...</p>
            ) : workspaces.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No workspaces yet. Add a workspace from the Apps page; it will appear here like in Library.
              </p>
            ) : (
              <ScrollArea className="max-h-[520px]">
                <div className="space-y-6">
                  {workspaces.map((ws) => (
                    <WorkspaceMcpCard key={ws.id} workspace={ws} maxServers={MAX_WORKSPACE_MCP} />
                  ))}
                </div>
              </ScrollArea>
            )}
            <p className="text-xs text-muted-foreground mt-3">
              Add or remove MCP servers per workspace above. Use @mcp name in chat when that workspace is active.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
