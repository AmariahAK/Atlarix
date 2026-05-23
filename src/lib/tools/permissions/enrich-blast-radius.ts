/**
 * Attach Blueprint blast-radius metadata to permission requests before approval.
 * Skipped in autonomous mode — no approval UI and writes must not block on graph analysis.
 */

import {
  analyzeBlastRadius,
  blastRadiusToPermissionMetadata,
} from "@/lib/blueprint/blast-radius";
import { shouldAutoApprovePermissions } from "@/ipc/handlers/autonomous-permissions";
import type { PermissionMetadata } from "./schema";

export async function enrichPermissionWithBlastRadius(
  workspace: string | undefined,
  filepath: string,
  opts?: {
    agentMode?: string;
    chatSessionId?: number;
    workspaceId?: number;
  },
): Promise<PermissionMetadata | undefined> {
  if (!workspace) return undefined;
  if (shouldAutoApprovePermissions(opts?.agentMode, opts?.chatSessionId)) {
    return undefined;
  }
  try {
    const result = await analyzeBlastRadius({
      projectPath: workspace,
      filepath,
      workspaceId: opts?.workspaceId,
    });
    return blastRadiusToPermissionMetadata(result);
  } catch {
    return undefined;
  }
}
