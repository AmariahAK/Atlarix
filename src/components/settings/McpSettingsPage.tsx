/**
 * MCP Settings — workspace-scoped to the active IDE workspace (selectedAppId).
 */

import { useState } from "react";
import { useAtomValue } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useSearch } from "@tanstack/react-router";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ToolsMcpSettings } from "./ToolsMcpSettings";
import { McpMarketplaceTab } from "./McpMarketplaceTab";
import { OrphanedMcpSection } from "./OrphanedMcpSection";
import { selectedAppIdAtom, selectedWorkspaceInfoAtom } from "@/atoms/appAtoms";

const MAX_WORKSPACE_MCP = 10;

function WorkspaceRequiredEmpty() {
  return (
    <p className="text-sm text-muted-foreground py-6">
      Open a workspace from the welcome screen or sidebar to manage MCP servers
      for that project.
    </p>
  );
}

export function McpSettingsPage() {
  const queryClient = useQueryClient();
  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const workspaceInfo = useAtomValue(selectedWorkspaceInfoAtom);
  // Deep link: /integrations/mcp?tab=marketplace (first-run wizard CTA).
  const search = useSearch({ strict: false }) as { tab?: string };
  const [activeTab, setActiveTab] = useState<"active" | "marketplace">(() =>
    search?.tab === "marketplace" ? "marketplace" : "active",
  );

  const workspaceName = workspaceInfo?.name ?? "Workspace";

  /**
   * Content only. The page shell — scroll container, width, back button, and the
   * workspace name/path header — belongs to the `/integrations` layout now, which
   * is also what lets the copy below drop "your current workspace": the route
   * and the header above already say which project this is.
   */
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-foreground">MCP servers</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Up to {MAX_WORKSPACE_MCP} per workspace. Use{" "}
          <code className="text-xs bg-muted px-1 rounded">@mcp name</code> in
          chat.
        </p>
      </div>

      {!selectedAppId ? (
        <WorkspaceRequiredEmpty />
      ) : (
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

          {/* The workspace name/path header that used to repeat here is gone —
                the /integrations layout shows it once, above the section nav. */}
          <TabsContent value="active" className="space-y-8 mt-4">
            <div className="bg-card rounded-xl shadow-sm p-6 border border-border">
              <ToolsMcpSettings
                scope="workspace"
                appId={selectedAppId}
                maxServers={MAX_WORKSPACE_MCP}
              />
            </div>
            <OrphanedMcpSection workspaceAppId={selectedAppId} />
          </TabsContent>

          <TabsContent value="marketplace" className="mt-4">
            <div className="bg-card rounded-xl shadow-sm p-6 border border-border">
              <McpMarketplaceTab
                workspaceId={selectedAppId}
                workspaceName={workspaceName}
                onChanged={() => {
                  void queryClient.invalidateQueries({ queryKey: ["mcp"] });
                }}
              />
            </div>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
