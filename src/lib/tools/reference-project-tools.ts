/**
 * add_reference_project: Add a reference project path for combined blueprint (v3.6).
 */

import {
  ToolRegistry,
  ToolCategory,
  createParameters,
  stringParam,
} from "./registry";
import { getReferencePaths, setReferencePaths } from "../blueprint/reference-manager";

type AddReferenceArgs = {
  project_path: string;
  workspace?: string;
};

ToolRegistry.register({
  name: "add_reference_project",
  description:
    "Add another project path as a reference for the current workspace. Reference projects are included in the combined blueprint view and cross-project analysis. Use an absolute path. Call list_reference_projects to see current list.",
  category: ToolCategory.TASK,
  cost: 0,
  requiresWorkspace: true,
  isCore: false,
  isReadOnly: false,
  parameters: createParameters(
    {
      project_path: stringParam("Absolute path to the project folder to add as reference"),
    },
    ["project_path"]
  ),
  handler: async (args: AddReferenceArgs): Promise<Record<string, unknown>> => {
    const workspace = args.workspace as string | undefined;
    const projectPath = String(args.project_path ?? "").trim();
    if (!workspace) {
      return { success: false, error: "No workspace active. Open a workspace first." };
    }
    if (!projectPath) {
      return { success: false, error: "project_path is required." };
    }
    const existing = await getReferencePaths(workspace);
    if (existing.includes(projectPath)) {
      return { success: true, message: "Project already in reference list.", paths: existing };
    }
    const next = [...existing, projectPath];
    await setReferencePaths(workspace, next);
    return {
      success: true,
      message: `Added reference project. Total: ${next.length}.`,
      paths: next,
    };
  },
});
