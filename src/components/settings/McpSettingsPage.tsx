/**
 * MCP Settings — workspace-scoped to the active IDE workspace (selectedAppId).
 */

import { useState } from "react";
import { useAtomValue } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Folder, Sparkles } from "lucide-react";
import { useRouter, useSearch } from "@tanstack/react-router";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import { ToolsMcpSettings } from "./ToolsMcpSettings";
import { McpMarketplaceTab } from "./McpMarketplaceTab";
import { OrphanedMcpSection } from "./OrphanedMcpSection";
import { selectedAppIdAtom, selectedWorkspaceInfoAtom } from "@/atoms/appAtoms";

const MAX_WORKSPACE_MCP = 10;

function WorkspaceRequiredEmpty() {
  return (
    <p className="text-sm text-muted-foreground py-6">
      Open a workspace from the welcome screen or sidebar to manage MCP servers for that
      project.
    </p>
  );
}

export function McpSettingsPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const workspaceInfo = useAtomValue(selectedWorkspaceInfoAtom);
  // Deep link: /settings/mcp?tab=marketplace (first-run wizard CTA).
  const search = useSearch({ strict: false }) as { tab?: string };
  const [activeTab, setActiveTab] = useState<"active" | "marketplace">(() =>
    search?.tab === "marketplace" ? "marketplace" : "active",
  );

  const workspaceName = workspaceInfo?.name ?? "Workspace";
  const workspacePath = workspaceInfo?.path ?? "";

  return (
    <div className="flex-1 min-h-0 bg-background overflow-y-auto">
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
            MCP servers for your <strong>current workspace</strong> only (max{" "}
            {MAX_WORKSPACE_MCP} per workspace). Use{" "}
            <code className="text-xs bg-muted px-1 rounded">@mcp name</code> in chat.
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

            <TabsContent value="active" className="space-y-8 mt-4">
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Folder className="w-5 h-5 text-primary" />
                  <div className="min-w-0">
                    <h2 className="text-xl font-semibold text-foreground truncate">
                      {workspaceName}
                    </h2>
                    {workspacePath ? (
                      <p className="text-xs text-muted-foreground truncate">{workspacePath}</p>
                    ) : null}
                  </div>
                </div>
                <div className="bg-card rounded-xl shadow-sm p-6 border border-border">
                  <ToolsMcpSettings
                    scope="workspace"
                    appId={selectedAppId}
                    maxServers={MAX_WORKSPACE_MCP}
                  />
                </div>
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
    </div>
  );
}
