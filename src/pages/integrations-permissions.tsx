/**
 * Project permissions — what the agent may run and write, in one project.
 *
 * These three blocks were the "Workflow Settings" card on the global Settings
 * page, where their own copy gave the problem away: "...can be managed per
 * workspace below when a workspace is selected". They read `selectedAppIdAtom`
 * and were always per-project.
 *
 * They live under Integrations rather than Settings because they are not a
 * preference — they are the policy governing what a connection is allowed to
 * do, which is the same question the rest of this page answers.
 */

import { useAtomValue } from "jotai";
import { Folder } from "lucide-react";
import { selectedAppIdAtom, selectedWorkspaceInfoAtom } from "@/atoms/appAtoms";
import { WorkspaceTerminalPermissions } from "@/components/settings/WorkspaceTerminalPermissions";
import {
  WorkspaceFilePermissions,
  WorkspaceGrantedFolders,
} from "@/components/settings/WorkspaceFilePermissions";

export function IntegrationsPermissionsPage() {
  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const workspaceInfo = useAtomValue(selectedWorkspaceInfoAtom);

  if (selectedAppId == null) {
    return (
      <p className="text-sm text-muted-foreground py-6">
        Open a workspace from the welcome screen or the sidebar to manage its
        permissions.
      </p>
    );
  }

  return (
    <div className="bg-card rounded-xl shadow-sm p-6 border border-border">
      <div className="flex items-start gap-2 mb-2">
        <Folder className="w-5 h-5 text-primary shrink-0 mt-0.5" aria-hidden />
        <div className="min-w-0">
          <h2 className="text-lg font-medium text-foreground truncate">
            {workspaceInfo?.name?.trim() || "This project"}
          </h2>
          {workspaceInfo?.path?.trim() ? (
            <p className="text-xs text-muted-foreground truncate font-mono">
              {workspaceInfo.path}
            </p>
          ) : null}
        </div>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        File writes and commands are approved inline in chat as they happen. The
        rules below are the standing decisions — what runs without asking, and
        which folders outside this project the agent may write to. Nothing here
        affects your other workspaces.
      </p>
      <WorkspaceTerminalPermissions />
      <WorkspaceFilePermissions />
      <WorkspaceGrantedFolders />
    </div>
  );
}
