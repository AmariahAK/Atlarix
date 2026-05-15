/**
 * MCP Settings Page — Pass 7
 * ==========================
 * Two tabs:
 *   - Active: existing global + workspace MCP managers (`ToolsMcpSettings`).
 *   - Marketplace: discover and one-click install MCPs from the public registry
 *     (`atlarix-mcps`), with env-var collection and per-scope install.
 *
 * Both views share the same enforcement (5 global / 5 per workspace) and
 * upgrade gates surfaced server-side from `mcp_handlers.ts`.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Folder, Globe, Sparkles } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import { ToolsMcpSettings } from "./ToolsMcpSettings";
import { McpMarketplaceTab } from "./McpMarketplaceTab";
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
      <ToolsMcpSettings scope="workspace" appId={workspace.id} maxServers={maxServers} />
    </div>
  );
}

export function McpSettingsPage() {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<WorkspaceWithStatus[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"active" | "marketplace">("active");

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
    void loadWorkspaces();
  }, [loadWorkspaces]);

  return (
    <div className="flex-1 bg-background overflow-auto">
      <div className="max-w-4xl mx-auto px-8 py-6 pb-20 space-y-6">
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
            Connect Model Context Protocol servers — filesystem, GitHub, Postgres, Slack, Sentry, and
            anything else with an MCP implementation. Use{" "}
            <code className="text-xs bg-muted px-1 rounded">@mcp name</code> in chat to call a server.
          </p>
        </div>

        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as "active" | "marketplace")}
        >
          <TabsList>
            <TabsTrigger value="active">Active</TabsTrigger>
            <TabsTrigger value="marketplace">
              <Sparkles className="h-3.5 w-3.5 mr-1.5" />
              Marketplace
            </TabsTrigger>
          </TabsList>

          <TabsContent value="active" className="space-y-8 mt-4">
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

            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Folder className="w-5 h-5 text-primary" />
                <h2 className="text-xl font-semibold text-foreground">Workspace MCP</h2>
              </div>
              <p className="text-sm text-muted-foreground">
                Project-specific servers, used only when that workspace is active in chat. Max{" "}
                {MAX_WORKSPACE_MCP} per workspace.
              </p>
              <div className="bg-card rounded-xl shadow-sm p-6 border border-border">
                {workspacesLoading ? (
                  <p className="text-sm text-muted-foreground">Loading workspaces...</p>
                ) : workspaces.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No workspaces yet. Add a workspace from the Apps page; it will appear here.
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
                  Add or remove MCP servers per workspace above. Use @mcp name in chat when that
                  workspace is active.
                </p>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="marketplace" className="mt-4">
            <div className="bg-card rounded-xl shadow-sm p-6 border border-border">
              <McpMarketplaceTab
                workspaces={workspaces.map((w) => ({ id: w.id, name: w.name }))}
              />
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
